#!/usr/bin/env node
/**
 * Read-only probe: verify the nightly backup LaunchAgent is healthy, locate
 * the backup directory, report age + count of backups, and estimate restore
 * feasibility.
 *
 * Safe — shells out to launchctl + ls only. No DB touch, no network.
 */
const { execSync } = require('child_process');
const fs = require('fs');

function run(cmd) {
  try { return execSync(cmd, { encoding: 'utf8' }); }
  catch (e) { return `(error: ${e.message.split('\n')[0]})`; }
}

console.log('=== Backup LaunchAgent status ===');
console.log(run('launchctl list | grep paireyewear.labassistant.backup || echo "(not loaded)"'));

console.log('=== Backup plist ===');
const plistCandidates = [
  '/Users/labassistant/Library/LaunchAgents/com.paireyewear.labassistant.backup.plist',
  '/Library/LaunchDaemons/com.paireyewear.labassistant.backup.plist',
];
for (const p of plistCandidates) {
  if (fs.existsSync(p)) {
    console.log(`FOUND: ${p}`);
    console.log(run(`grep -A1 "StartCalendarInterval\\|ProgramArguments\\|StandardOutPath\\|StandardErrorPath\\|WorkingDirectory" "${p}"`));
  }
}

console.log('\n=== Candidate backup directories ===');
const dirs = [
  '/Users/Shared/lab_assistant/backups',
  '/Users/Shared/lab_assistant/data/backups',
  '/Users/labassistant/backups',
  '/Volumes/Backup',
];
for (const d of dirs) {
  if (fs.existsSync(d)) {
    console.log(`\nDIR: ${d}`);
    console.log(run(`ls -lht "${d}" | head -10`));
    console.log(run(`ls "${d}" | wc -l | awk '{print "  total files: "$1}'`));
    console.log(run(`du -sh "${d}" 2>/dev/null | awk '{print "  total size: "$1}'`));
  } else {
    console.log(`MISSING: ${d}`);
  }
}

console.log('\n=== Backup script location (if referenced) ===');
console.log(run('find /Users/Shared/lab_assistant -name "backup*.sh" -o -name "backup*.js" 2>/dev/null | head -5'));

console.log('\n=== Backup log (if exists) ===');
const logs = [
  '/Users/Shared/lab_assistant/server/data/backup.log',
  '/Users/Shared/lab_assistant/data/backup.log',
  '/Users/Shared/lab_assistant/backups/backup.log',
];
for (const l of logs) {
  if (fs.existsSync(l)) {
    console.log(`LOG: ${l}`);
    console.log(run(`tail -20 "${l}"`));
  }
}

console.log('\n=== Disk headroom (for potential restore + VACUUM) ===');
console.log(run('df -h /Users/Shared/lab_assistant'));

console.log('\n=== Prod DB current size ===');
console.log(run('ls -lh /Users/Shared/lab_assistant/data/lab_assistant.db'));
