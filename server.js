const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Helpers ──

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const HISTORY_FILE = path.join(CLAUDE_DIR, 'history.jsonl');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

const MAX_FILE_SIZE = 2 * 1024 * 1024;        // 2 MB skip threshold
const TAIL_THRESHOLD = 256 * 1024;             // 256 KB tail-read threshold
const MAX_LINE_LENGTH = 50000;                 // Skip lines over 50 KB
const MAX_SESSIONS_PER_BRANCH = 6;

function parseJsonlFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    const entries = [];
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line));
      } catch { /* skip malformed lines */ }
    }
    return entries;
  } catch {
    return [];
  }
}

function hashProjectPath(projectPath) {
  // Replace / with -, keeping the leading dash
  return projectPath.replace(/\//g, '-');
}

function findSessionFile(sessionId, projectPath) {
  const hash = hashProjectPath(projectPath);
  const direct = path.join(PROJECTS_DIR, hash, `${sessionId}.jsonl`);
  if (fs.existsSync(direct)) return direct;

  // Scan worktree project dirs: they start with the same hash prefix
  try {
    const dirs = fs.readdirSync(PROJECTS_DIR);
    for (const dir of dirs) {
      if (dir === hash || !dir.startsWith(hash)) continue;
      const candidate = path.join(PROJECTS_DIR, dir, `${sessionId}.jsonl`);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {}

  return null;
}

function parseSessionFile(sessionId, projectPath) {
  const result = { summary: '', branch: null, cwd: null };
  const sessionFile = findSessionFile(sessionId, projectPath);
  if (!sessionFile) return result;

  try {
    const stat = fs.statSync(sessionFile);
    if (stat.size > MAX_FILE_SIZE) return result;

    let content;
    if (stat.size > TAIL_THRESHOLD) {
      // For large files: read head (for branch/cwd) + tail (for summary)
      const fd = fs.openSync(sessionFile, 'r');

      // Head read for branch/cwd
      const headBuf = Buffer.alloc(Math.min(8192, stat.size));
      fs.readSync(fd, headBuf, 0, headBuf.length, 0);
      for (const line of headBuf.toString('utf-8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (!result.branch && obj.gitBranch) result.branch = obj.gitBranch;
          if (!result.cwd && obj.cwd) result.cwd = obj.cwd;
          if (result.branch && result.cwd) break;
        } catch {}
      }

      // Tail read for summary
      const tailBuf = Buffer.alloc(TAIL_THRESHOLD);
      const bytesRead = fs.readSync(fd, tailBuf, 0, TAIL_THRESHOLD, stat.size - TAIL_THRESHOLD);
      fs.closeSync(fd);
      content = tailBuf.slice(0, bytesRead).toString('utf-8');
      const firstNewline = content.indexOf('\n');
      if (firstNewline !== -1) content = content.slice(firstNewline + 1);
    } else {
      content = fs.readFileSync(sessionFile, 'utf-8');
    }

    for (const line of content.split('\n')) {
      if (!line.trim() || line.length > MAX_LINE_LENGTH) continue;
      try {
        const obj = JSON.parse(line);
        if (!result.branch && obj.gitBranch) result.branch = obj.gitBranch;
        if (!result.cwd && obj.cwd) result.cwd = obj.cwd;

        if (obj.type === 'assistant') {
          let text = '';
          const msgContent = obj.message?.content;
          if (typeof msgContent === 'string') {
            text = msgContent;
          } else if (Array.isArray(msgContent)) {
            text = msgContent
              .filter(b => b.type === 'text' && b.text)
              .map(b => b.text)
              .join(' ');
          }
          if (text) result.summary = text;
        }
      } catch {}
    }

    if (result.summary.length > 500) result.summary = result.summary.slice(0, 500);
    return result;
  } catch {
    return result;
  }
}

function detectBranch(projectPath) {
  try {
    const gitPath = path.join(projectPath, '.git');
    const gitStat = fs.statSync(gitPath);

    if (gitStat.isFile()) {
      // Worktree: .git is a file pointing to the real git dir
      const gitContent = fs.readFileSync(gitPath, 'utf-8').trim();
      const match = gitContent.match(/gitdir:\s*(.+)/);
      if (match) {
        const headContent = fs.readFileSync(path.join(match[1], 'HEAD'), 'utf-8').trim();
        const prefix = 'ref: refs/heads/';
        if (headContent.startsWith(prefix)) {
          return headContent.slice(prefix.length).trim();
        }
      }
      return 'main';
    }

    // Normal repo
    const content = fs.readFileSync(path.join(gitPath, 'HEAD'), 'utf-8').trim();
    const prefix = 'ref: refs/heads/';
    if (content.startsWith(prefix)) {
      return content.slice(prefix.length).trim();
    }
    return 'main';
  } catch {
    return 'main';
  }
}

function loadSessions() {
  const entries = parseJsonlFile(HISTORY_FILE);
  if (entries.length === 0) return [];

  // Group by sessionId
  const groups = {};
  for (const entry of entries) {
    const sid = entry.sessionId;
    if (!sid) continue;
    if (!groups[sid]) groups[sid] = [];
    groups[sid].push(entry);
  }

  const now = Date.now() / 1000;
  const sessions = [];

  for (const [sid, group] of Object.entries(groups)) {
    // Sort by timestamp ascending
    group.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

    const first = group[0];
    const last = group[group.length - 1];
    const prompt = first.display || '';
    if (!prompt) continue;

    const projectPath = first.project || 'unknown';
    const ts = (last.timestamp || 0) / 1000; // ms -> seconds
    const age = now - ts;

    let status;
    if (age < 300) status = 'running';
    else if (age < 600) status = 'needsInput';
    else status = 'archived';

    const parsed = parseSessionFile(sid, projectPath);
    const branch = parsed.branch || detectBranch(parsed.cwd || projectPath);

    sessions.push({
      id: sid,
      prompt,
      summary: parsed.summary,
      status,
      timestamp: last.timestamp || 0,
      projectPath,
      branch,
    });
  }

  return sessions;
}

function groupSessions(sessions) {
  // Group by projectPath
  const projMap = {};
  for (const s of sessions) {
    if (!projMap[s.projectPath]) projMap[s.projectPath] = [];
    projMap[s.projectPath].push(s);
  }

  const projects = [];

  for (const [projPath, projSessions] of Object.entries(projMap)) {
    const name = path.basename(projPath) || projPath;

    // Group by branch
    const branchMap = {};
    for (const s of projSessions) {
      const b = s.branch || 'main';
      if (!branchMap[b]) branchMap[b] = [];
      branchMap[b].push(s);
    }

    const branches = [];
    for (const [branchName, branchSessions] of Object.entries(branchMap)) {
      // Sort by timestamp descending, cap at 6
      branchSessions.sort((a, b) => b.timestamp - a.timestamp);
      const capped = branchSessions.slice(0, MAX_SESSIONS_PER_BRANCH);

      branches.push({
        name: branchName,
        sessions: capped,
      });
    }

    // Sort branches: active first, then alphabetical
    branches.sort((a, b) => {
      const aActive = a.sessions.some(s => s.status === 'running' || s.status === 'needsInput');
      const bActive = b.sessions.some(s => s.status === 'running' || s.status === 'needsInput');
      if (aActive && !bActive) return -1;
      if (!aActive && bActive) return 1;
      return a.name.localeCompare(b.name);
    });

    const activeCount = projSessions.filter(s => s.status === 'running' || s.status === 'needsInput').length;

    projects.push({
      name,
      path: projPath,
      activeCount,
      branches,
    });
  }

  // Sort projects: more active first, then alphabetical
  projects.sort((a, b) => {
    if (b.activeCount !== a.activeCount) return b.activeCount - a.activeCount;
    return a.name.localeCompare(b.name);
  });

  return projects;
}

// ── Routes ──

app.get('/api/sessions', (req, res) => {
  try {
    const sessions = loadSessions();
    const projects = groupSessions(sessions);
    res.json({ projects });
  } catch (e) {
    console.error('Error loading sessions:', e);
    res.json({ projects: [] });
  }
});

app.post('/api/open-session', (req, res) => {
  const { sessionId, projectPath } = req.body;
  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId required' });
  }

  // Escape single quotes for shell
  const safePath = (projectPath || '').replace(/'/g, "'\\''");
  const safeId = sessionId.replace(/'/g, "'\\''");

  const cdCmd = safePath ? `cd '${safePath}' && ` : '';
  const cmd = `osascript -e 'tell application "Terminal" to activate' -e 'tell application "Terminal" to do script "${cdCmd}claude --resume ${safeId}"'`;

  exec(cmd, (err) => {
    if (err) {
      console.error('Failed to open session:', err);
      return res.status(500).json({ error: 'Failed to open terminal' });
    }
    res.json({ ok: true });
  });
});

// ── Start ──

app.listen(PORT, () => {
  console.log(`Claude Canvas running at http://localhost:${PORT}`);
});
