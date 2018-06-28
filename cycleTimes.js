const axios = require("axios");
const subWeeks = require('date-fns/sub_weeks');
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

// calculate column times for issues in given repo
const transitionsForRepo = async (repo, date) => {
    const repoId = await getGitHubRepoId(repo);

    // search GH for issues closed in specific range, excluding configured labels
    const startOfSearch = startOfWeek(date, { weekStartsOn: 1 }).toISODateString();
    const endOfSearch = endOfWeek(date, { weekStartsOn: 1 }).toISODateString();
    
    const ghQuery = `repo:${repo} closed:${startOfSearch}..${endOfSearch} ${excludeLabelSearchString}`;
    const closedIssuesInRange = await searchGitHubIssues(ghQuery);

    const transitionPromises = closedIssuesInRange
        // only necessary info from issue
        .map(issue => ({
            title: issue.title,
            number: issue.number,
            closedAt: issue.closed_at
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

            const filteredIssue = { number: issue.number, title: issue.title};

            for (pipeline of config.pipelines) {
                const start = issue.events.find(event => event.to_pipeline.name.startsWith(pipeline.name));
                const end = issue.events.find(event => event.from_pipeline.name.startsWith(pipeline.name));
                
                if (start && end) {
                    filteredIssue.columnTimes = filteredIssue.columnTimes || {};
                    filteredIssue.columnTimes[pipeline.id] = {};
                    filteredIssue.columnTimes[pipeline.id].seconds = differenceInSeconds(end.created_at, start.created_at);
                    filteredIssue.columnTimes[pipeline.id].words = distanceInWordsStrict(end.created_at, start.created_at);
                };

                // no end time, assume end is issue closed
                if(start && !end) {
                    filteredIssue.columnTimes = filteredIssue.columnTimes || {};
                    filteredIssue.columnTimes[pipeline.id] = {};
                    filteredIssue.columnTimes[pipeline.id].seconds = differenceInSeconds(issue.closedAt, start.created_at);
                    filteredIssue.columnTimes[pipeline.id].words = distanceInWordsStrict(issue.closedAt, start.created_at);
                }
            }

            return filteredIssue;
        });

        const transitions = Promise.all(transitionPromises);
        return transitions;
}

// logic
const printCycleTimes = async (date) => {
    const issueDetailsPromises = config.repos.map(repo => transitionsForRepo(repo, date));

    // a bit of work to combine async arrays
    const issueDetails = (await Promise.all(issueDetailsPromises))
                            .reduce((left, right) => left.concat(right), []);
    
    const columnTimes = issueDetails.filter(issue => issue.columnTimes);

    // sum all column times for one issue, and sum all issue times
    const columnTimeAdder = (sum, issue) => {
        return sum + Object.keys(issue.columnTimes).reduce((columnSum, column) => (issue.columnTimes[column].seconds + columnSum), 0);
    };

    // average of sums
    const average = columnTimes.reduce(columnTimeAdder, 0) / issueDetails.length;

    if(config.debug) {
       console.log(JSON.stringify(columnTimes, null, 2));
    }

    const days = Math.round(average / 86400);
    const hours = Math.round(average % 86400 / 60 / 60);
    
    console.log(`Average cycle time for ${issueDetails.length} issues is ${days} days and ${hours} hours`);
};

//default to last week
printCycleTimes(subWeeks(new Date(), 1).toISOString());