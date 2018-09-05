const axios = require("axios");
const subWeeks = require('date-fns/sub_weeks');
const getISOWeek = require('date-fns/get_iso_week');
const startOfWeek = require('date-fns/start_of_week');
const endOfWeek = require('date-fns/end_of_week');
const differenceInSeconds = require('date-fns/difference_in_seconds');
const distanceInWordsStrict = require('date-fns/distance_in_words_strict');

const config = require('./cycleTimeConfig.json');
const excludeLabelSearchString = config.excludeLabels.map(label => `-label:"${label}"`).join(' '); 

// hack for easier date printing for API use
if (!Date.prototype.toISODateString) {
    (function() {
  
      function pad(number) {
        if (number < 10) {
          return '0' + number;
        }
        return number;
      }
  
      Date.prototype.toISODateString = function() {
        return this.getUTCFullYear() +
          '-' + pad(this.getUTCMonth() + 1) +
          '-' + pad(this.getUTCDate());
      };
  
    }());
  }

// generic method for accessing GH API
const getGitHub = async (url, params = {}) => {
    try {
        const response = await axios.get(url, {
            baseURL: 'https://api.github.com',
            headers: { 'Authorization': 'token ' + config.gitHubToken },
            params: params
        });

        const data = response.data;

        if (config.debug) {
            console.log(data);
        }

        return data;

    } catch (error) {
        console.log(error);
    }
};

// generic method for accessing ZenHub API
const getZenHub = async (url) => {
    try {
        const response = await axios.get(url, {
            baseURL: 'https://api.zenhub.io',
            headers: { 'X-Authentication-Token': config.zenHubToken }
        });

        const data = response.data;

        if (config.debug) {
            console.log(data);
        }

        return data;

    } catch (error) {
        console.log(error);
    }
};

// Retrieve all ZenHub events for a GH issue
const getZenHubIssueEvents = async (repository, issue) => {
    const url = `/p1/repositories/${repository}/issues/${issue}/events`;

    return await getZenHub(url);
}

// Retrieve all issues for a GH repo
// Use params object to configure
const getGitHubRepoIssues = async (repository, params) => {
    const url = `/repos/${repository}/issues`;

    const allIssues = await getGitHub(url, params);
    return allIssues.filter(issue => !issue.pull_request);
}

// Retrieve technical id for GH repo
const getGitHubRepoId = async (repository) => {
    const url = `/repos/${repository}`;

    const repo = await getGitHub(url, {});
    return repo.id;
}

// search GH for issue type issues
const searchGitHubIssues = async(query) => {
    const url = `/search/issues`;
    const modifiedQuery = `${query} type:issue`;
    
    if(config.debug) {
        console.log(`Searched for ${modifiedQuery}`);
    }

    const allIssues = await getGitHub(url, {
        q: modifiedQuery,
        sort: 'updated'
    });

    return allIssues.items;
}

const secondsToDuration = (input) => {
    let seconds = input;
    const result = {};
    result.days = Math.floor(seconds / (3600 * 24));
    seconds -= result.days * 3600 * 24;
    result.hours = Math.floor(seconds / 3600);
    seconds  -= result.hours * 3600;
    result.minutes = Math.floor(seconds / 60);
    return result;
}

// calculate column times for issues in given repo
const transitionsForRepo = async (repo, date) => {
    const repoId = await getGitHubRepoId(repo);

    const startDate = subWeeks(date, 4);
    
    // search GH for issues closed in specific range, excluding configured labels
    const startOfSearch = startOfWeek(startDate, { weekStartsOn: 1 }).toISODateString();
    const endOfSearch = endOfWeek(date, { weekStartsOn: 1 }).toISODateString();
    
    const ghQuery = `repo:${repo} closed:${startOfSearch}..${endOfSearch} ${excludeLabelSearchString}`;
    const closedIssuesInRange = await searchGitHubIssues(ghQuery);

    const transitionPromises = closedIssuesInRange
        // only necessary info from issue
        .map(issue => ({
            title: issue.title,
            number: issue.number,
            closedAt: issue.closed_at,
            assignees: issue.assignees.map(assignee => assignee.login)
        }))

        // add transfer events from ZenHub
        .map(async issue => {
            issue.events = await getZenHubIssueEvents(repoId, issue.number);
            issue.events = issue.events.filter(event => event.type === 'transferIssue');
            return issue;
        })

        // calculate times for configured pipelines
        .map(async issuePromise => {
            const issue = await issuePromise;

            const filteredIssue = { number: issue.number, title: issue.title, assignees: issue.assignees};

            for (pipeline of config.pipelines) {
                const start = issue.events.find(event => event.to_pipeline.name.startsWith(pipeline.name));
                const end = issue.events.find(event => event.from_pipeline.name.startsWith(pipeline.name));
                
                if (start && end) {
                    filteredIssue.columnTimes = filteredIssue.columnTimes || {};
                    filteredIssue.columnTimes[pipeline.id] = {};
                    filteredIssue.columnTimes[pipeline.id].seconds = differenceInSeconds(end.created_at, start.created_at);
                    filteredIssue.columnTimes[pipeline.id].words = distanceInWordsStrict(end.created_at, start.created_at);
                };
            }

            const closeTransition = issue.events.find(event => event.to_pipeline.name.startsWith(config.endPipeline));
            if (closeTransition) {
                filteredIssue.closedAt = closeTransition.created_at;
            }

            return filteredIssue;
        });

        const transitions = Promise.all(transitionPromises);
        return transitions;
}

// logic
const getCycleTimes = async (date) => {
    const issueDetailsPromises = config.repos.map(repo => transitionsForRepo(repo, date));

    // a bit of work to combine async arrays
    const issueDetails = (await Promise.all(issueDetailsPromises))
                            .reduce((left, right) => left.concat(right), [])
                            .filter(issue => issue.closedAt != undefined);

    const issuesByWeek = issueDetails
        .reduce((accumulator, issue) => {
            const week = getISOWeek(issue.closedAt).toString();
            if(!accumulator.has(week)) {
                accumulator.set(week, []);
            }
            const weekArray = accumulator.get(week);
            weekArray.push(issue);
            return accumulator;
        }, new Map());

    const issuesByWeekArray = Array.from(issuesByWeek);
    issuesByWeekArray.sort((left, right) => left[0] > right[0]);
    return Promise.all(issuesByWeekArray.map(([key, value]) => getCycleTimesForWeek(key, value)));
};

const getCycleTimesForWeek = async (weekNumber, issues) => {
    const columnTimes = issues.filter(issue => issue.columnTimes)
                              .map(issue => {
                                const columnSumSeconds = Object.keys(issue.columnTimes).reduce((columnSum, column) => (issue.columnTimes[column].seconds + columnSum), 0)
                                const duration = secondsToDuration(columnSumSeconds);
                                const sumWords = `${duration.days} days, ${duration.hours} hours and ${duration.minutes} minutes`
                                return Object.assign(issue, {sum: sumWords});
                              });

    // sum all column times for one issue, and sum all issue times
    const columnTimeAdder = (sum, issue) => {
        return sum + Object.keys(issue.columnTimes).reduce((columnSum, column) => (issue.columnTimes[column].seconds + columnSum), 0);
    };

    // average of sums
    const average = columnTimes.length != 0 ? columnTimes.reduce(columnTimeAdder, 0) / columnTimes.length : 0;

    if(config.printIssueDetails) {
        console.log(`Week number ${weekNumber}`);
        console.log(JSON.stringify(columnTimes, null, 2));
    }

    const duration = secondsToDuration(average);

    return `Average cycle time for ${columnTimes.length} issues in week ${weekNumber} is ${duration.days} days, ${duration.hours} hours and ${duration.minutes} minutes.`;
}

getCycleTimes(new Date().toISOString()).then(cycleTimes => cycleTimes.forEach(week => console.log(week)));
