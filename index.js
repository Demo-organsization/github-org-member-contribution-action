const arraySort = require('array-sort')
const core = require('@actions/core')
const github = require('@actions/github')
const stringify = require('csv-stringify/lib/sync')
const { GitHub } = require('@actions/github/lib/utils')
const { retry } = require('@octokit/plugin-retry')
const { throttling } = require('@octokit/plugin-throttling')
const fs = require('fs')

// Enable throttling and retries
const MyOctokit = GitHub.plugin(throttling, retry)
const eventPayload = require(process.env.GITHUB_EVENT_PATH)
const org = core.getInput('org', { required: false }) || eventPayload.organization.login
const token = core.getInput('token', { required: true })

const octokit = new MyOctokit({
  auth: token,
  request: {
    retries: 3,
    retryAfter: 180
  },
  throttle: {
    onRateLimit: (retryAfter, options, octokit) => {
      octokit.log.warn(`Rate limit hit for request ${options.method} ${options.url}`)
      if (options.request.retryCount === 0) {
        octokit.log.info(`Retrying after ${retryAfter} seconds...`)
        return true
      }
    },
    onAbuseLimit: (retryAfter, options, octokit) => {
      octokit.log.warn(`Abuse limit detected for ${options.method} ${options.url}`)
    }
  }
})

// Main contribution fetcher
async function getMemberActivity(orgid, from, to, contribArray) {
  let paginationMember = null
  const query = `query ($org: String!, $orgid: ID, $cursorID: String, $from: DateTime, $to: DateTime) {
    organization(login: $org) {
      membersWithRole(first: 25, after: $cursorID) {
        nodes {
          login
          contributionsCollection(organizationID: $orgid, from: $from, to: $to) {
            hasAnyContributions
            totalCommitContributions
            totalIssueContributions
            totalPullRequestContributions
            totalPullRequestReviewContributions
            totalRepositoriesWithContributedIssues
            totalRepositoriesWithContributedCommits
            totalRepositoriesWithContributedPullRequests
            totalRepositoriesWithContributedPullRequestReviews
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }`

  try {
    let hasNextPageMember = false

    do {
      const getMemberResult = await octokit.graphql({
        query,
        org,
        orgid,
        from,
        to,
        cursorID: paginationMember
      })

      const membersObj = getMemberResult.organization.membersWithRole.nodes
      hasNextPageMember = getMemberResult.organization.membersWithRole.pageInfo.hasNextPage
      paginationMember = hasNextPageMember ? getMemberResult.organization.membersWithRole.pageInfo.endCursor : null

      for (const member of membersObj) {
        const {
          login,
          contributionsCollection: {
            hasAnyContributions,
            totalCommitContributions,
            totalIssueContributions,
            totalPullRequestContributions,
            totalPullRequestReviewContributions,
            totalRepositoriesWithContributedIssues,
            totalRepositoriesWithContributedCommits,
            totalRepositoriesWithContributedPullRequests,
            totalRepositoriesWithContributedPullRequestReviews
          }
        } = member

        console.log(`${login}: hasContrib=${hasAnyContributions}, commits=${totalCommitContributions}`)
        contribArray.push({
          userName: login,
          activeContrib: hasAnyContributions,
          commitContrib: totalCommitContributions,
          issueContrib: totalIssueContributions,
          prContrib: totalPullRequestContributions,
          prreviewContrib: totalPullRequestReviewContributions,
          repoIssueContrib: totalRepositoriesWithContributedIssues,
          repoCommitContrib: totalRepositoriesWithContributedCommits,
          repoPullRequestContrib: totalRepositoriesWithContributedPullRequests,
          repoPullRequestReviewContrib: totalRepositoriesWithContributedPullRequestReviews
        })
      }
    } while (hasNextPageMember)
  } catch (error) {
    core.setFailed(error.message)
  }
}

;(async () => {
  try {
    // Get org ID
    const getOrgIdResult = await octokit.graphql(`query ($org: String!) {
      organization(login: $org) { id }
    }`, { org })

    const orgid = getOrgIdResult.organization.id
    console.log(`Organization ID: ${orgid}`)

    // Get date range
    const fromdate = core.getInput('fromdate', { required: false })
    const todate = core.getInput('todate', { required: false })
    let from, to, fileDate, logDate, columnDate

    const isValidDate = (date) => /^\d{4}-\d{2}-\d{2}$/.test(date)

    if (isValidDate(fromdate) && isValidDate(todate)) {
      from = new Date(fromdate).toISOString()
      to = new Date(todate).toISOString()
      fileDate = `${fromdate}-to-${todate}`
      columnDate = logDate = `${fromdate} to ${todate}`
    } else {
      const days = parseInt(core.getInput('days', { required: false }) || '30', 10)
      to = new Date()
      from = new Date()
      from.setDate(to.getDate() - days)
      columnDate = `<${days} days`
      fileDate = `${days}-days`
      logDate = `${days} days`
      from = from.toISOString()
      to = to.toISOString()
    }

    console.log(`Generating report from ${from} to ${to}`)

    // Fetch contributions
    const contribArray = []
    await getMemberActivity(orgid, from, to, contribArray)

    if (contribArray.length === 0) {
      console.log('⚠️ No contributions found for any members.')
    } else {
      console.log(`✅ Found contributions for ${contribArray.length} members`)
    }

    // CSV headers
    const columns = {
      userName: 'Member',
      activeContrib: `Has active contributions (${columnDate})`,
      commitContrib: `Commits created (${columnDate})`,
      issueContrib: `Issues opened (${columnDate})`,
      prContrib: `PRs opened (${columnDate})`,
      prreviewContrib: `PR reviews (${columnDate})`,
      repoIssueContrib: `Issue spread (${columnDate})`,
      repoCommitContrib: `Commit spread (${columnDate})`,
      repoPullRequestContrib: `PR spread (${columnDate})`,
      repoPullRequestReviewContrib: `PR review spread (${columnDate})`
    }

    const sortColumn = core.getInput('sort', { required: false }) || 'commitContrib'
    const sortedArray = arraySort(contribArray, sortColumn, { reverse: true })
    sortedArray.unshift(columns)

    const csv = stringify(sortedArray, {
      cast: {
        boolean: value => value ? 'TRUE' : 'FALSE'
      }
    })

    // Prepare file name
    const reportPath = `reports/${org}-${new Date().toISOString().substring(0, 19)}-${fileDate}.csv`
    const committerName = core.getInput('committer-name', { required: false }) || 'github-actions'
    const committerEmail = core.getInput('committer-email', { required: false }) || 'github-actions@github.com'
    const { owner, repo } = github.context.repo

    // Push CSV to repo
    const opts = {
      owner,
      repo,
      path: reportPath,
      message: `${new Date().toISOString().slice(0, 10)} Member contribution report`,
      content: Buffer.from(csv).toString('base64'),
      committer: {
        name: committerName,
        email: committerEmail
      }
    }

    console.log(`📄 Writing report to ${reportPath}`)
    await octokit.rest.repos.createOrUpdateFileContents(opts)
    console.log('✅ Report successfully pushed to the repository.')
  } catch (error) {
    core.setFailed(error.stack || error.message)
  }
})()
