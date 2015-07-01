'use strict';

var doiuse = require('doiuse');
var github = require('octonode');
var path = require('path');
var postcss = require('postcss');
var Q = require('q');
var sendRequest = require('request');
var diff = require('./diffParse');
var logger = require('./logger');
var parseSource = require('./sourceParse');

var token = 'token ' + process.env.OAUTH_TOKEN;
var productName = 'Discord';
var configFilename = '.doiuse';
var githubClient = github.client();

function handle(request, response) {
    var eventType = request.headers['x-github-event'];
    var metadata = request.body;
    var originRepo;

    response.status(200).send('OK');

    // React to pull requests only
    if (eventType === 'pull_request') {
        originRepo = metadata.pull_request.head.repo.full_name;

        logger.log('Pull request received:', metadata);
        trackUsage(originRepo);

        addPullRequestComments(
            metadata.repository.full_name,
            originRepo,
            metadata.pull_request.head.ref,
            metadata.number,
            metadata.pull_request.review_comments_url
        );
    }
}

// TODO: Remove the commentURL parameter once parseCSS is refactored
function addPullRequestComments(destinationRepo, originRepo, originBranch, prNumber, commentURL) {
    var commits = getPullRequestCommits(destinationRepo, prNumber);
    var config = getConfig(originRepo, originBranch);

    Q.all([commits, config]).spread(function(commits, config) {
        commits.forEach(function(currentCommit) {
            parseCSS(currentCommit.files, config, commentURL, token, function(usageInfo) {}, currentCommit.sha);
        });
    }).catch(function(error) {
        logger.error(error);
    });
}

function getConfig(repo, branch) {
    var deferred = Q.defer();
    var repoClient = githubClient.repo(repo);

    repoClient.contents(configFilename, branch, function(error, configFileMetadata) {
        var config = ['last 2 versions']; // Default configuration

        // If the file is found, massage the file contents and use that configuration
        if (!error) {
            // Consider text separated by commas and linebreaks to be individual options
            config = new Buffer(configFileMetadata.content, 'base64').toString()
                .replace(/\r?\n|\r/g, ', ')
                .split(/,\s*/);
        }

        deferred.resolve(config);
    });

    return deferred.promise;
}

function getPullRequestCommits(repo, number) {
    var deferred = Q.defer();

    var prClient = githubClient.pr(repo, number);

    prClient.commits(function(error, commits) {
        var promises = [];

        if (error) {
            deferred.reject('Fetching commits failed: ' + error);
        } else {

            // Build an array of commit detail promises
            commits.forEach(function(currentCommit) {
                promises.push(getCommitDetail(repo, currentCommit.sha));
            });

            // When all of the commit detail promises have been resolved,
            // resolve an array of commit detail
            Q.all(promises).spread(function() {
                deferred.resolve(Array.prototype.slice.call(arguments));
            });

        }
    });

    return deferred.promise;
}

function getCommitDetail(repo, sha) {
    var deferred = Q.defer();
    var repoClient = githubClient.repo(repo);

    repoClient.commit(sha, function(error, commitDetail) {
        if (error) {
            deferred.reject('Fetching commit detail failed: ' + error);
        } else {
            deferred.resolve(commitDetail);
        }
    });

    return deferred.promise;
}

function trackUsage(repo) {
    logger.log('Compatibility test requested from:', repo);
}

var parseCSS = function(files, config, commentURL, token, cb, sha) {
    files.forEach(function(file, index) {
        var addFeature = function(feature) {
            var diffIndex = diff.lineToIndex(file.patch, feature.usage.source.start.line);
            var comment = feature.featureData.title + ' not supported by: ' + feature.featureData.missing;
            renderComment(commentURL, file.filename, comment, diffIndex, token, sha);
        };
        var fileExtension = path.extname(file.filename).toLowerCase();

        if (fileExtension === '.styl') {
            parseSource.stylus(file, config, addFeature);
        } else if (fileExtension === '.css') {
            sendRequest({
                url: file.raw_url,
                headers: {
                    'User-Agent': productName
                }
            }, function(error, response, body) {
                var contents = body;
                postcss(doiuse({
                    browsers: config,
                    onFeatureUsage: addFeature
                })).process(contents, {
                    from: '/' + file.filename
                }).then(function(response) {});
            });
        }
    });
};

var renderComment = function(url, file, comment, position, token, sha) {
    sendRequest({
        url: url,
        method: 'POST',
        headers: {
            'User-Agent': productName,
            'Authorization': token
        },
        body: JSON.stringify({
            body: comment,
            path: file,
            commit_id: sha,
            position: position
        })
    }, function(error, response, body) {
        if (error) return logger.error('renderComment/sendRequest failed:', error);
    });
};

exports.handle = handle;
