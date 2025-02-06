const express = require('express');
const axios = require('axios');
const dotenv = require('dotenv');
const cors = require('cors');

dotenv.config();
const app = express();
const PORT = process.env.PORT || 5000;

app.use(express.json());
app.use(cors());

const GITHUB_API_URL = 'https://api.github.com';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

const githubApi = axios.create({
  baseURL: GITHUB_API_URL,
  headers: {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: 'application/vnd.github.v3+json',
  },
});

// Helper function to check rate limits and retry
async function makeGitHubRequest(url) {
  try {
    return await githubApi.get(url);
  } catch (error) {
    if (error.response?.status === 403 && error.response?.headers['x-ratelimit-remaining'] === '0') {
      return { error: 'GitHub API rate limit exceeded', retry_after: error.response?.headers['x-ratelimit-reset'] };
    }
    throw error;
  }
}

// 1. Get Commit by ID
app.get('/repositories/:owner/:repository/commits/:oid', async (req, res) => {
  const { owner, repository, oid } = req.params;

  try {
    const response = await makeGitHubRequest(`/repos/${owner}/${repository}/commits/${oid}`);
    if (response.error) return res.status(429).json(response);

    const commitData = response.data;
    const formattedCommit = {
      oid: commitData.sha,
      message: commitData.commit.message,
      author: commitData.commit.author,
      committer: commitData.commit.committer,
      parents: commitData.parents.map(parent => ({ oid: parent.sha })),
    };

    res.json([formattedCommit]);
  } catch (error) {
    res.status(error.response?.status || 500).json({ message: 'Error fetching commit details', error: error.message });
  }
});

// 2. Get Commit Diff
app.get('/repositories/:owner/:repository/commits/:oid/diff', async (req, res) => {
  const { owner, repository, oid } = req.params;

  try {
    const commitResponse = await makeGitHubRequest(`/repos/${owner}/${repository}/commits/${oid}`);
    if (commitResponse.error) return res.status(429).json(commitResponse);

    const parentOid = commitResponse.data.parents?.[0]?.sha;
    if (!parentOid) return res.status(400).json({ message: 'No parent commit found' });

    const diffResponse = await makeGitHubRequest(`/repos/${owner}/${repository}/compare/${parentOid}...${oid}`);
    if (diffResponse.error) return res.status(429).json(diffResponse);

    const files = diffResponse.data.files.map(file => ({
      changeKind: file.status.toUpperCase(),
      headFile: { path: file.filename },
      baseFile: { path: file.filename },
      hunks: file.patch ? parsePatch(file.patch) : []
    }));

    res.json(files);
  } catch (error) {
    res.status(error.response?.status || 500).json({ message: 'Error fetching commit diff', error: error.message });
  }
});

function parsePatch(patch) {
  const hunks = [];
  const lines = patch.split('\n');
  let currentHunk = null;
  let baseLine = 0, headLine = 0;

  lines.forEach(line => {
    if (line.startsWith('@@')) {
      if (currentHunk) hunks.push(currentHunk);
      const match = line.match(/^@@ -(\d+),?\d* \+(\d+),?\d* @@/);
      if (match) [baseLine, headLine] = [parseInt(match[1]), parseInt(match[2])];

      currentHunk = { header: line, lines: [] };
    } else if (currentHunk) {
      let baseLineNumber = null, headLineNumber = null;
      if (line.startsWith('-')) baseLineNumber = baseLine++;
      else if (line.startsWith('+')) headLineNumber = headLine++;
      else [baseLineNumber, headLineNumber] = [baseLine++, headLine++];

      currentHunk.lines.push({ baseLineNumber, headLineNumber, content: line });
    }
  });

  if (currentHunk) hunks.push(currentHunk);
  return hunks;
}

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
