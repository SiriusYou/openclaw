#!/usr/bin/env bash
# ============================================================================
# generate-customer-report.sh — Static HTML Customer Report Generator
# ============================================================================
#
# Read-only script that collects status from existing data sources and
# generates a self-contained HTML report (no external dependencies).
#
# Data sources:
#   - marketing/customers/*.json manifests (brand, audience, skills, config)
#   - customer-status.sh --json output (gateway status, cost, backup)
#   - ~/.openclaw-{id}/cost-report-latest.json (per-profile cost data)
#   - ~/.openclaw/backups/customers/{id}/ (backup timestamps)
#
# Usage:
#   ./generate-customer-report.sh [--output <path>] [--json]
#
# Options:
#   --output <path>   Override output location (default: /tmp/openclaw/customer-report.html)
#   --json            Output raw collected data as JSON instead of HTML
#   -h, --help        Show this help
#
# This script does NOT modify any state or config.
# ============================================================================

set -euo pipefail

# --- Paths ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MARKETING_DIR="$(dirname "$SCRIPT_DIR")"
CUSTOMERS_DIR="$MARKETING_DIR/customers"
DEFAULT_OUTPUT="/tmp/openclaw/customer-report.html"

# --- Options ---
OUTPUT_PATH="$DEFAULT_OUTPUT"
JSON_OUTPUT=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output)
      shift
      OUTPUT_PATH="${1:-}"
      if [[ -z "$OUTPUT_PATH" ]]; then
        echo "Error: --output requires a path argument" >&2
        exit 1
      fi
      ;;
    --json)
      JSON_OUTPUT=true
      ;;
    -h|--help)
      echo "Usage: $0 [--output <path>] [--json]"
      echo ""
      echo "Generate a static HTML report of all customer statuses."
      echo ""
      echo "Options:"
      echo "  --output <path>   Output file (default: marketing/status/customer-report.html)"
      echo "  --json            Output raw data as JSON instead of HTML"
      echo "  -h, --help        Show this help"
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
  shift
done

# --- Check prerequisites ---
if [[ ! -d "$CUSTOMERS_DIR" ]]; then
  echo "Error: No customers directory at $CUSTOMERS_DIR" >&2
  exit 1
fi

# --- Staleness threshold (48 hours in seconds) ---
STALE_THRESHOLD=172800

# --- Collect customer data via node for reliable JSON handling ---
REPORT_JSON=$(node -e "
  const fs = require('fs');
  const path = require('path');
  const os = require('os');

  const customersDir = process.argv[1];
  const staleThreshold = parseInt(process.argv[2], 10) * 1000;
  const home = os.homedir();
  const now = Date.now();

  const manifests = fs.readdirSync(customersDir)
    .filter(f => f.endsWith('.json'))
    .sort();

  const customers = [];

  for (const file of manifests) {
    const filePath = path.join(customersDir, file);
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      continue;
    }

    if (manifest.status === 'template') continue;

    const id = manifest.customerId || path.basename(file, '.json');
    const brand = manifest.brandName || '?';
    const status = manifest.status || 'unknown';
    const port = manifest.port || null;
    const audience = manifest.audience || '';
    const channels = manifest.channels || [];
    const skills = manifest.skills || [];
    const timezone = manifest.reporting?.timezone || null;

    // Cost data
    let costStatus = null;
    let costTotal = null;
    let costCoverage = null;
    let costGeneratedAt = null;
    const costFile = path.join(home, '.openclaw-' + id, 'cost-report-latest.json');
    if (fs.existsSync(costFile)) {
      try {
        const report = JSON.parse(fs.readFileSync(costFile, 'utf8'));
        const generatedAt = new Date(report.generatedAt);
        const ageMs = now - generatedAt.getTime();
        const utcHours = generatedAt.getUTCHours() + generatedAt.getUTCMinutes() / 60;
        costCoverage = Math.min(1.0, utcHours / 24);
        costGeneratedAt = report.generatedAt;
        costTotal = report.totalCost || 0;

        const warn = manifest.costAlert?.dailyWarning ?? 15;
        const crit = manifest.costAlert?.dailyCritical ?? 20;

        if (ageMs > staleThreshold) {
          costStatus = 'STALE';
        } else if (costTotal >= crit) {
          costStatus = 'CRITICAL';
        } else if (costTotal >= warn) {
          costStatus = 'WARNING';
        } else {
          costStatus = 'OK';
        }
      } catch {}
    }

    // Backup data
    let backupStatus = null;
    let lastBackup = null;
    const backupDir = path.join(home, '.openclaw', 'backups', 'customers', id);
    if (fs.existsSync(backupDir)) {
      try {
        const files = fs.readdirSync(backupDir)
          .filter(f => f.endsWith('.tar.gz'))
          .sort()
          .reverse();
        if (files.length > 0) {
          const stat = fs.statSync(path.join(backupDir, files[0]));
          const ageMs = now - stat.mtime.getTime();
          backupStatus = ageMs > staleThreshold ? 'STALE' : 'OK';
          lastBackup = stat.mtime.toISOString();
        }
      } catch {}
    }

    // State directory
    const stateDir = path.join(home, '.openclaw-' + id);
    const hasState = fs.existsSync(stateDir);

    customers.push({
      customerId: id,
      brandName: brand,
      status,
      port,
      audience,
      channels,
      skills,
      timezone,
      hasState,
      cost: {
        status: costStatus,
        total: costTotal,
        coverage: costCoverage,
        generatedAt: costGeneratedAt
      },
      backup: {
        status: backupStatus,
        lastBackup
      }
    });
  }

  const summary = {
    total: customers.length,
    active: customers.filter(c => c.status === 'active').length,
    withState: customers.filter(c => c.hasState).length,
    costOk: customers.filter(c => c.cost.status === 'OK').length,
    costWarning: customers.filter(c => c.cost.status === 'WARNING' || c.cost.status === 'CRITICAL').length,
    backupOk: customers.filter(c => c.backup.status === 'OK').length,
    backupStale: customers.filter(c => c.backup.status === 'STALE').length
  };

  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), summary, customers }, null, 2));
" "$CUSTOMERS_DIR" "$STALE_THRESHOLD" 2>/dev/null)

if [[ -z "$REPORT_JSON" ]]; then
  echo "Error: Failed to collect customer data" >&2
  exit 1
fi

# --- JSON output mode ---
if [[ "$JSON_OUTPUT" == "true" ]]; then
  echo "$REPORT_JSON"
  exit 0
fi

# --- Generate HTML ---
OUTPUT_DIR="$(dirname "$OUTPUT_PATH")"
if [[ ! -d "$OUTPUT_DIR" ]]; then
  mkdir -p "$OUTPUT_DIR"
fi

node -e "
  const data = JSON.parse(process.argv[1]);
  const { generatedAt, summary, customers } = data;

  const ts = new Date(generatedAt).toLocaleString('en-US', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Shanghai'
  });

  function badge(status) {
    const colors = {
      active:   { bg: '#dcfce7', fg: '#166534', border: '#bbf7d0' },
      paused:   { bg: '#fef9c3', fg: '#854d0e', border: '#fde68a' },
      disabled: { bg: '#fee2e2', fg: '#991b1b', border: '#fecaca' },
      unknown:  { bg: '#f3f4f6', fg: '#6b7280', border: '#e5e7eb' },
      OK:       { bg: '#dcfce7', fg: '#166534', border: '#bbf7d0' },
      WARNING:  { bg: '#fef9c3', fg: '#854d0e', border: '#fde68a' },
      CRITICAL: { bg: '#fee2e2', fg: '#991b1b', border: '#fecaca' },
      STALE:    { bg: '#fef9c3', fg: '#854d0e', border: '#fde68a' },
      running:  { bg: '#dcfce7', fg: '#166534', border: '#bbf7d0' },
      stopped:  { bg: '#fee2e2', fg: '#991b1b', border: '#fecaca' },
    };
    const c = colors[status] || colors.unknown;
    return '<span style=\"display:inline-block;padding:2px 10px;border-radius:9999px;font-size:12px;font-weight:600;background:\${c.bg};color:\${c.fg};border:1px solid \${c.border}\">\${status}</span>';
  }

  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function costDisplay(cost) {
    if (!cost.status) return '<span style=\"color:#9ca3af\">No data</span>';
    const total = cost.total !== null ? '\$' + cost.total.toFixed(2) : '?';
    const coverage = cost.coverage !== null ? (cost.coverage * 100).toFixed(0) + '%' : '?';
    return badge(cost.status) + ' <span style=\"margin-left:6px;font-size:13px;color:#6b7280\">' + total + ' (coverage: ' + coverage + ')</span>';
  }

  function backupDisplay(backup) {
    if (!backup.status) return '<span style=\"color:#9ca3af\">No backups</span>';
    const ago = backup.lastBackup ? timeAgo(new Date(backup.lastBackup)) : '?';
    return badge(backup.status) + ' <span style=\"margin-left:6px;font-size:13px;color:#6b7280\">' + ago + '</span>';
  }

  function timeAgo(date) {
    const ms = Date.now() - date.getTime();
    const hours = Math.floor(ms / 3600000);
    if (hours < 1) return 'just now';
    if (hours < 24) return hours + 'h ago';
    const days = Math.floor(hours / 24);
    return days + 'd ago';
  }

  const customerCards = customers.map(c => {
    const skillList = c.skills.length > 0
      ? c.skills.map(s => '<span style=\"display:inline-block;padding:1px 8px;margin:2px;border-radius:4px;font-size:11px;background:#f0f0f0;color:#555;border:1px solid #e0e0e0\">' + escHtml(s) + '</span>').join('')
      : '<span style=\"color:#9ca3af\">None</span>';

    const channelList = c.channels.map(ch => escHtml(ch)).join(', ') || 'None';

    return \`
    <div style=\"background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:24px;margin-bottom:16px;box-shadow:0 1px 3px rgba(0,0,0,0.06)\">
      <div style=\"display:flex;justify-content:space-between;align-items:center;margin-bottom:16px\">
        <div>
          <h3 style=\"margin:0;font-size:18px;font-weight:700;color:#111\">\${escHtml(c.brandName)}</h3>
          <span style=\"font-size:13px;color:#6b7280;font-family:monospace\">\${escHtml(c.customerId)}</span>
        </div>
        <div style=\"display:flex;gap:8px;align-items:center\">
          \${badge(c.status)}
        </div>
      </div>

      <div style=\"display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:16px\">
        <div>
          <div style=\"font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:#9ca3af;margin-bottom:4px\">Port</div>
          <div style=\"font-size:14px;font-family:monospace;color:#374151\">\${c.port || '--'}</div>
        </div>
        <div>
          <div style=\"font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:#9ca3af;margin-bottom:4px\">Channels</div>
          <div style=\"font-size:14px;color:#374151\">\${channelList}</div>
        </div>
        <div>
          <div style=\"font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:#9ca3af;margin-bottom:4px\">Timezone</div>
          <div style=\"font-size:14px;color:#374151\">\${c.timezone || '--'}</div>
        </div>
        <div>
          <div style=\"font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:#9ca3af;margin-bottom:4px\">State Dir</div>
          <div style=\"font-size:14px;color:#374151\">\${c.hasState ? 'Present' : 'Missing'}</div>
        </div>
      </div>

      <div style=\"display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px\">
        <div style=\"background:#fafafa;border-radius:8px;padding:12px\">
          <div style=\"font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:#9ca3af;margin-bottom:6px\">Cost Status</div>
          <div>\${costDisplay(c.cost)}</div>
        </div>
        <div style=\"background:#fafafa;border-radius:8px;padding:12px\">
          <div style=\"font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:#9ca3af;margin-bottom:6px\">Backup Status</div>
          <div>\${backupDisplay(c.backup)}</div>
        </div>
      </div>

      \${c.audience ? '<div style=\"margin-bottom:12px\"><div style=\"font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:#9ca3af;margin-bottom:4px\">Audience</div><div style=\"font-size:13px;color:#6b7280\">' + escHtml(c.audience) + '</div></div>' : ''}

      <div>
        <div style=\"font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:#9ca3af;margin-bottom:6px\">Skills (\${c.skills.length})</div>
        <div style=\"line-height:1.8\">\${skillList}</div>
      </div>
    </div>\`;
  }).join('');

  const html = \`<!DOCTYPE html>
<html lang=\"en\">
<head>
  <meta charset=\"UTF-8\">
  <meta name=\"viewport\" content=\"width=device-width,initial-scale=1.0\">
  <title>Customer Report — OpenClaw Marketing</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f8f9fa;
      color: #111;
      line-height: 1.5;
      padding: 32px 16px;
    }
    .container { max-width: 960px; margin: 0 auto; }
    .header {
      text-align: center;
      margin-bottom: 32px;
      padding-bottom: 24px;
      border-bottom: 1px solid #e5e7eb;
    }
    .header h1 {
      font-size: 24px;
      font-weight: 700;
      color: #111;
      margin-bottom: 4px;
    }
    .header .subtitle {
      font-size: 13px;
      color: #9ca3af;
    }
    .summary {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
      gap: 12px;
      margin-bottom: 32px;
    }
    .summary-card {
      background: #fff;
      border: 1px solid #e5e7eb;
      border-radius: 10px;
      padding: 16px;
      text-align: center;
    }
    .summary-card .value {
      font-size: 28px;
      font-weight: 700;
      color: #111;
    }
    .summary-card .label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: #9ca3af;
      margin-top: 2px;
    }
    .footer {
      text-align: center;
      padding-top: 24px;
      margin-top: 24px;
      border-top: 1px solid #e5e7eb;
      font-size: 12px;
      color: #9ca3af;
    }
  </style>
</head>
<body>
  <div class=\"container\">
    <div class=\"header\">
      <h1>Customer Report</h1>
      <div class=\"subtitle\">Generated \${escHtml(ts)} (Asia/Shanghai) &mdash; OpenClaw Marketing Platform</div>
    </div>

    <div class=\"summary\">
      <div class=\"summary-card\">
        <div class=\"value\">\${summary.total}</div>
        <div class=\"label\">Total</div>
      </div>
      <div class=\"summary-card\">
        <div class=\"value\">\${summary.active}</div>
        <div class=\"label\">Active</div>
      </div>
      <div class=\"summary-card\">
        <div class=\"value\">\${summary.costOk}</div>
        <div class=\"label\">Cost OK</div>
      </div>
      <div class=\"summary-card\">
        <div class=\"value\" style=\"color:\${summary.costWarning > 0 ? '#dc2626' : '#111'}\">\${summary.costWarning}</div>
        <div class=\"label\">Cost Alerts</div>
      </div>
      <div class=\"summary-card\">
        <div class=\"value\">\${summary.backupOk}</div>
        <div class=\"label\">Backup OK</div>
      </div>
      <div class=\"summary-card\">
        <div class=\"value\" style=\"color:\${summary.backupStale > 0 ? '#ca8a04' : '#111'}\">\${summary.backupStale}</div>
        <div class=\"label\">Backup Stale</div>
      </div>
    </div>

    \${customerCards || '<div style=\"text-align:center;color:#9ca3af;padding:48px\">No customers found</div>'}

    <div class=\"footer\">
      Read-only report &mdash; no state modified. Source: marketing/scripts/generate-customer-report.sh
    </div>
  </div>
</body>
</html>\`;

  process.stdout.write(html);
" "$REPORT_JSON" > "$OUTPUT_PATH"

echo "Report generated: $OUTPUT_PATH"
