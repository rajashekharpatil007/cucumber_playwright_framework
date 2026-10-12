const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const reportsDirectory = path.join(root, "reports");
const resultFile = path.join(reportsDirectory, "cucumber-data.json");
const htmlFile = path.join(reportsDirectory, "cucumber.html");
const cucumberPackagePath = path.join(
  root,
  "node_modules",
  "@cucumber",
  "cucumber",
  "package.json",
);

fs.mkdirSync(reportsDirectory, { recursive: true });

const cucumberPackage = JSON.parse(fs.readFileSync(cucumberPackagePath, "utf8"));
const cucumberCommand = path.resolve(
  path.dirname(cucumberPackagePath),
  cucumberPackage.bin["cucumber-js"],
);
const cucumberResult = spawnSync(
  process.execPath,
  [
    cucumberCommand,
    "--config",
    "cucumber.json",
    "--format",
    "pretty",
    "--format",
    "json:reports/cucumber-data.json",
  ],
  { cwd: root, env: process.env, stdio: "inherit" },
);

let features = [];
let reportError = "";

try {
  features = JSON.parse(fs.readFileSync(resultFile, "utf8"));
} catch (error) {
  reportError = error.message;
}

const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (character) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character];
  });

const redactPassword = (value) =>
  String(value ?? "").replace(/(password\s+["'])[^"']+(["'])/gi, "$1[redacted]$2");
const sanitizeResults = (value, key = "") => {
  if (Array.isArray(value)) return value.map((item) => sanitizeResults(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        /password/i.test(childKey) ? "[redacted]" : sanitizeResults(childValue, childKey),
      ]),
    );
  }
  if (typeof value === "string") return redactPassword(value);
  return value;
};
const scenarios = features.flatMap((feature) =>
  (feature.elements ?? [])
    .filter((element) => element.type === "scenario" || element.type === "scenario_outline")
    .map((scenario) => {
      const executionSteps = scenario.steps ?? [];
      const steps = executionSteps.map((step) => ({
        ...step,
        name: step.name ?? `${step.keyword} hook`,
      }));
      const statuses = executionSteps.map((step) => step.result?.status ?? "unknown");
      const status = statuses.some((value) => ["failed", "undefined", "ambiguous"].includes(value))
        ? "failed"
        : statuses.length > 0 && statuses.every((value) => value === "passed")
          ? "passed"
          : "skipped";
      const duration = executionSteps.reduce(
        (total, step) => total + (step.result?.duration ?? 0),
        0,
      );
      const text = executionSteps.filter((step) => step.name).map((step) => step.name).join(" ");
      const endpoint = text.match(/https?:\/\/[^\s"']+/)?.[0] ?? "Not recorded";
      const username = text.match(/username\s+["']([^"']+)["']/i)?.[1] ?? "Not recorded";
      const password = text.match(/password\s+["']([^"']+)["']/i)?.[1];

      return {
        feature: feature.name,
        name: scenario.name,
        uri: (feature.uri ?? "").replace(/\\/g, "/"),
        line: scenario.line,
        status,
        duration,
        endpoint,
        username,
        password: password ? "[redacted]" : "Not recorded",
        steps,
      };
    }),
);

const stepCounts = { passed: 0, failed: 0, skipped: 0 };
for (const scenario of scenarios) {
  for (const step of scenario.steps) {
    const status = step.result?.status ?? "unknown";
    if (status === "passed") stepCounts.passed += 1;
    else if (["failed", "undefined", "ambiguous"].includes(status)) stepCounts.failed += 1;
    else stepCounts.skipped += 1;
  }
}

const scenarioCounts = {
  passed: scenarios.filter((scenario) => scenario.status === "passed").length,
  failed: scenarios.filter((scenario) => scenario.status === "failed").length,
  skipped: scenarios.filter((scenario) => scenario.status === "skipped").length,
};
const scenarioTotal = scenarios.length;
const stepTotal = Object.values(stepCounts).reduce((total, value) => total + value, 0);
const passPercent = scenarioTotal ? (scenarioCounts.passed / scenarioTotal) * 100 : 0;
const failedPercent = scenarioTotal ? (scenarioCounts.failed / scenarioTotal) * 100 : 0;
const skippedPercent = Math.max(0, 100 - passPercent - failedPercent);
const generatedAt = new Date().toLocaleString();

const scenarioMarkup = scenarios.map((scenario) => {
  const scenarioSteps = scenario.steps.map((step) => {
    const status = step.result?.status ?? "unknown";
    const statusClass = ["failed", "undefined", "ambiguous"].includes(status)
      ? "failed"
      : status === "passed"
        ? "passed"
        : "skipped";
    const durationMs = ((step.result?.duration ?? 0) / 1_000_000).toFixed(0);

    return `<li class="step-row">
      <span class="step-status ${statusClass}" aria-label="${escapeHtml(status)}"></span>
      <span class="step-name"><span class="step-keyword">${escapeHtml(step.keyword)}</span>${escapeHtml(redactPassword(step.name))}</span>
      <span class="step-duration">${durationMs} ms</span>
    </li>`;
  }).join("");
  const durationMs = (scenario.duration / 1_000_000).toFixed(0);
  const location = `${scenario.uri}${scenario.line ? `:${scenario.line}` : ""}`;

  return `<article class="scenario">
    <div class="scenario-heading">
      <div><p class="eyebrow">${escapeHtml(scenario.feature)}</p><h3>${escapeHtml(scenario.name)}</h3></div>
      <span class="badge ${scenario.status}">${escapeHtml(scenario.status)}</span>
    </div>
    <p class="source">${escapeHtml(location)} <span>·</span> ${durationMs} ms</p>
    <div class="run-details">
      <div><span>Endpoint</span><a href="${escapeHtml(scenario.endpoint)}" target="_blank" rel="noreferrer">${escapeHtml(scenario.endpoint)}</a></div>
      <div><span>Username</span><code>${escapeHtml(scenario.username)}</code></div>
      <div><span>Password</span><code>${escapeHtml(scenario.password)}</code></div>
    </div>
    <ul class="steps">${scenarioSteps}</ul>
  </article>`;
}).join("");

const report = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Cucumber Execution Report</title>
  <style>
    :root{color-scheme:light;--ink:#1d2b2b;--muted:#667674;--paper:#f3f6f3;--panel:#fff;--line:#dce5e0;--green:#14815c;--red:#c34343;--amber:#bf7900;--teal:#176e73;--serif:Georgia,'Times New Roman',serif;--sans:'Trebuchet MS',Verdana,sans-serif}
    *{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:14px/1.5 var(--sans)}a{color:#116d73;overflow-wrap:anywhere}header{background:#173d3a;color:#f7fbf7;padding:30px max(24px,calc((100vw - 1180px)/2)) 34px;border-bottom:5px solid #c8783d}.topline{display:flex;justify-content:space-between;gap:16px;align-items:center;color:#c5d9d1;text-transform:uppercase;font-size:11px;letter-spacing:1px}.topline strong{color:#f0a86b}h1{font:normal 34px/1.15 var(--serif);margin:20px 0 8px}.subtitle{margin:0;color:#c5d9d1}.container{max-width:1180px;margin:26px auto;padding:0 24px}.section-title{font:normal 21px var(--serif);margin:28px 0 14px}.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.metric,.panel,.scenario{background:var(--panel);border:1px solid var(--line);border-radius:6px}.metric{padding:16px 18px}.metric-label{display:block;color:var(--muted);font-size:12px}.metric-value{display:block;font-size:27px;font-weight:700;margin-top:5px}.metric-note{color:var(--muted);font-size:11px}.passed-text{color:var(--green)}.failed-text{color:var(--red)}.skipped-text{color:var(--amber)}.overview{display:grid;grid-template-columns:280px minmax(0,1fr);gap:14px;margin-top:14px}.panel{padding:20px}.panel h2{font:normal 18px var(--serif);margin:0 0 16px}.chart-wrap{display:grid;grid-template-columns:120px 1fr;align-items:center;gap:18px}.donut{width:120px;aspect-ratio:1;border-radius:50%;background:conic-gradient(var(--green) 0% ${passPercent}%,var(--red) ${passPercent}% ${passPercent + failedPercent}%,#d2d9d3 ${passPercent + failedPercent}% 100%);display:grid;place-items:center;position:relative}.donut:after{content:'';position:absolute;inset:14px;background:white;border-radius:50%}.donut span{position:relative;z-index:1;font-weight:700;font-size:20px}.legend{display:grid;gap:9px}.legend-item{display:flex;justify-content:space-between;gap:8px;font-size:12px}.legend-label:before{content:'';display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:7px;background:var(--green)}.legend-item.failed .legend-label:before{background:var(--red)}.legend-item.skipped .legend-label:before{background:#d2d9d3}.bars{display:grid;gap:15px}.bar-row{display:grid;grid-template-columns:90px 1fr 60px;align-items:center;gap:12px;font-size:12px}.bar-track{height:10px;border-radius:5px;background:#e9efeb;overflow:hidden}.bar-fill{height:100%;width:var(--width);background:var(--green);border-radius:inherit}.bar-row.failed .bar-fill{background:var(--red)}.bar-row.skipped .bar-fill{background:#c1c9c3}.bar-count{text-align:right;color:var(--muted)}.metadata{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}.metadata span{padding:7px 10px;background:#e9f0ed;border-radius:4px;color:#40534e;font-size:12px}.scenario-list{display:grid;gap:14px}.scenario{padding:18px 20px}.scenario-heading{display:flex;justify-content:space-between;align-items:flex-start;gap:14px}.eyebrow{color:var(--teal);font-size:11px;text-transform:uppercase;margin:0 0 3px}.scenario h3{font-size:17px;margin:0}.badge{padding:4px 9px;border-radius:3px;text-transform:uppercase;font-weight:700;font-size:10px}.badge.passed{background:#e4f4ed;color:var(--green)}.badge.failed{background:#fae8e6;color:var(--red)}.badge.skipped{background:#f7eedb;color:var(--amber)}.source{color:var(--muted);font:11px/1.4 monospace;margin:8px 0 14px;overflow-wrap:anywhere}.source span{padding:0 4px}.run-details{display:grid;grid-template-columns:2fr 1fr 1fr;gap:10px;padding:12px;background:#f5f8f5;border:1px solid #e5ece7;border-radius:4px}.run-details div{min-width:0}.run-details div>span{display:block;color:var(--muted);font-size:10px;text-transform:uppercase;margin-bottom:3px}.run-details a,.run-details code{font-size:12px}.steps{padding:0;margin:12px 0 0;list-style:none}.step-row{display:grid;grid-template-columns:10px minmax(0,1fr) 55px;gap:10px;align-items:start;padding:8px 0;border-bottom:1px solid #edf1ee}.step-row:last-child{border-bottom:0}.step-status{width:8px;height:8px;border-radius:50%;margin-top:6px;background:var(--green)}.step-status.failed{background:var(--red)}.step-status.skipped{background:#c1c9c3}.step-name{overflow-wrap:anywhere}.step-keyword{display:inline-block;min-width:52px;color:var(--teal);font-weight:700}.step-duration{text-align:right;color:var(--muted);font:11px monospace}.empty,.error{padding:18px;border-radius:4px;background:#fff2e8;color:#734522}.footer{color:var(--muted);font-size:11px;padding:20px 0 34px}
    @media(max-width:760px){header{padding:22px 20px 26px}h1{font-size:28px}.container{padding:0 14px;margin-top:16px}.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.overview{grid-template-columns:1fr}.chart-wrap{grid-template-columns:100px 1fr}.donut{width:100px}.run-details{grid-template-columns:1fr}.scenario{padding:15px}.topline{align-items:flex-start;flex-direction:column}}
  </style>
</head>
<body>
  <header>
    <div class="topline"><span>Cucumber · Playwright execution</span><strong>${scenarioCounts.failed ? "ATTENTION REQUIRED" : "RUN COMPLETE"}</strong></div>
    <h1>Execution report</h1>
    <p class="subtitle">${scenarioTotal} scenario${scenarioTotal === 1 ? "" : "s"} · ${stepTotal} execution steps · generated ${escapeHtml(generatedAt)}</p>
  </header>
  <main class="container">
    <section class="metrics" aria-label="Execution totals">
      <div class="metric"><span class="metric-label">Scenarios</span><strong class="metric-value">${scenarioTotal}</strong><span class="metric-note">${stepTotal} execution steps</span></div>
      <div class="metric"><span class="metric-label">Passed</span><strong class="metric-value passed-text">${scenarioCounts.passed}</strong><span class="metric-note">${stepCounts.passed} steps passed</span></div>
      <div class="metric"><span class="metric-label">Failed</span><strong class="metric-value failed-text">${scenarioCounts.failed}</strong><span class="metric-note">${stepCounts.failed} steps failed</span></div>
      <div class="metric"><span class="metric-label">Skipped / pending</span><strong class="metric-value skipped-text">${scenarioCounts.skipped}</strong><span class="metric-note">${stepCounts.skipped} steps skipped</span></div>
    </section>
    <section class="overview" aria-label="Execution graphs">
      <div class="panel"><h2>Scenario outcome</h2><div class="chart-wrap"><div class="donut" role="img" aria-label="${passPercent.toFixed(0)} percent of scenarios passed"><span>${passPercent.toFixed(0)}%</span></div><div class="legend">
        <div class="legend-item"><span class="legend-label">Passed</span><strong>${scenarioCounts.passed}</strong></div>
        <div class="legend-item failed"><span class="legend-label">Failed</span><strong>${scenarioCounts.failed}</strong></div>
        <div class="legend-item skipped"><span class="legend-label">Skipped</span><strong>${scenarioCounts.skipped}</strong></div>
      </div></div></div>
      <div class="panel"><h2>Step outcomes</h2><div class="bars">
        ${Object.entries(stepCounts).map(([status, count]) => `<div class="bar-row ${status}"><span>${status[0].toUpperCase()}${status.slice(1)}</span><div class="bar-track"><div class="bar-fill" style="--width:${stepTotal ? (count / stepTotal) * 100 : 0}%"></div></div><span class="bar-count">${count} / ${stepTotal}</span></div>`).join("")}
      </div><div class="metadata"><span>Command: npm test</span><span>Browser: Chromium, headed</span><span>Runner: Cucumber.js</span></div></div>
    </section>
    <h2 class="section-title">Scenario details</h2>
    <section class="scenario-list">${scenarioMarkup || `<div class="empty">No scenarios were recorded.${reportError ? ` ${escapeHtml(reportError)}` : ""}</div>`}</section>
    <p class="footer">Sensitive values are redacted. Structured Cucumber results are stored in reports/cucumber-data.json.</p>
  </main>
</body>
</html>`;

fs.writeFileSync(htmlFile, report, "utf8");
fs.writeFileSync(resultFile, JSON.stringify(sanitizeResults(features), null, 2), "utf8");
console.log(`\nExecution dashboard: ${path.relative(root, htmlFile)}`);

if (cucumberResult.error) {
  console.error(cucumberResult.error);
  process.exitCode = 1;
} else {
  process.exitCode = cucumberResult.status ?? 1;
}
