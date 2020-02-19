import * as api from "./src/api";
import {
  App,
  descriptionTag,
  createdbyTag,
  generateAlertGraphTag,
  pushStats
} from "./src/app";
import * as yargs from "yargs";
import * as path from "path";
import { Monitor, SLO, Synthetic } from "./src/api";
import { lock } from "./src/api";
import equal from "deep-equal";

const fs = require("fs");

const args = yargs
  .command("push <apps>", "push datadog dashboards up")
  .option("name", {
    type: "string",
    description: "only push the matching app name"
  })
  .demandCommand();

console.log(`Parsing local apps...`);
console.time("   ...completed in");
const appFile = path.resolve(args.argv.apps as string);
const apps = require(appFile);
console.timeEnd("   ...completed in");

function getAppModifiedDate(appname: string) {
  const path = "./99designs/apps/";
  const stats = fs.statSync(path + appname.toLowerCase() + ".ts");
  return new Date(stats.mtime);
}

function parseDate(unixtime: string) {
  return new Date(parseInt(unixtime) * 1000);
}

if (!process.env["DD_API_KEY"] || !process.env["DD_APP_KEY"]) {
  console.error(
    "MISSING API KEYS - run again using \n" +
      "  aws-vault exec platform -- chamber exec dddk -- npm run sync\n\n"
  );
  process.exit(1);
}

const client = new api.Client(
  process.env["DD_API_KEY"],
  process.env["DD_APP_KEY"]
);

(async () => {
  console.log(`Fetching data from DataDog...`);
  console.time("   ...completed in");

  const dashboards = (await client.getDashboards())
    .filter(d => d.description && d.description.includes(descriptionTag))
    .map(d => ({ ...d, seen: false }));
  const monitors = (await client.getMonitors())
    .filter(d => d.tags && d.tags.find(t => t == createdbyTag))
    .map(d => ({ ...d, seen: false }));
  const slos = (await client.getSLOs())
    .filter(d => d.tags && d.tags.find(t => t == createdbyTag))
    .map(d => ({ ...d, seen: false }));
  const synthetics = (await client.getSynthetics())
    .filter(d => d.tags && d.tags.find(t => t == createdbyTag))
    .map(d => ({ ...d, seen: false }));

  console.timeEnd(`   ...completed in`);

  async function pushDashboard(app: App, stats: pushStats) {
    const existing = dashboards.find(d => d.title == app.board.title);

    if (existing) {
      existing.seen = true;
      app.board.id = existing.id;
      console.log(app.board);
      console.log("!+!+!+!+!+!+!+");
      console.log(lock.dashboards[existing.id]);
      if (equal(lock.dashboards[existing.id], app.board)) {
        console.log("skip! dashboards");
        stats.skipped++;
        return existing.id;
      }
      console.log(` - Updating dashboard ${app.board.title}`);
      await client.updateDashboard(existing.id, app.board);
      app.board.id = existing.id;
      lock.dashboards[app.board.id] = app.board;
      stats.updated++;
    } else {
      console.log(` - Creating dashboard ${app.board.title}`);
      const res = await client.createDashboard(app.board);
      app.board.id = res.id;
      lock.dashboards[app.board.id] = app.board;
      stats.created++;
    }
  }

  async function pushMonitor(
    monitor: Monitor,
    appname: string,
    stats: pushStats
  ): Promise<number> {
    const existing = monitors.find(d => d.name == monitor.name);

    if (existing) {
      monitor.id = existing.id;
      existing.seen = true;
      if (
        equal(
          lock.monitors[existing.id],
          JSON.parse(JSON.stringify(monitor, null, 2))
        )
      ) {
        console.log("skip! mon");
        stats.skipped++;
        return existing.id;
      }
      console.log(` - Updating monitor ${monitor.name}`);
      console.log(lock.monitors[monitor.id]);
      console.log("differs ------------------");
      console.log(monitor);
      const res = await client.updateMonitor(existing.id, monitor);
      lock.monitors[res.id] = monitor;
      stats.updated++;
      return existing.id;
    } else {
      console.log(` - Creating monitor ${monitor.name}`);
      const res = await client.createMonitor(monitor);
      monitor.id = res.data.id;
      lock.monitors[res.id] = monitor;
      stats.created++;
      return res.data.id;
    }
  }

  async function pushSynthetic(
    syn: Synthetic,
    appname: string,
    stats: pushStats
  ) {
    const existing = synthetics.find(d => d.name == syn.name);

    if (existing) {
      // the synthetic exists on datadog servers
      existing.seen = true;

      if (equal(syn, lock.synthetics[existing.public_id])) {
        console.log("skip! syn");
        stats.skipped++;
        return existing.public_id;
      }
      console.log(` - Updating synthetic ${syn.name}`);
      syn.public_id = (
        await client.updateSynthetic(existing.public_id, syn)
      ).data.public_id;
      lock.synthetics[syn.public_id] = syn;
      stats.updated++;
      return syn.public_id;
    } else {
      console.log(` - Creating synthetic ${syn.name}`);
      const res = await client.createSynthetic(syn);
      syn.public_id = res.public_id;
      lock.synthetics[syn.public_id] = syn;
      stats.created++;
      return syn.public_id;
    }
  }

  async function pushSLO(slo: SLO, appname: string, stats: pushStats) {
    const existing = slos.find(d => d.name == slo.name);

    if (existing) {
      existing.seen = true;
      slo.id = existing.id;
      // slos record time in UNIX format
      if (equal(slo, lock.slos[existing.id])) {
        console.log("skip! slo");
        stats.skipped++;
        return existing.id;
      }
      console.log(` - Updating ${slo.name}`);
      await client.updateSLO(existing.id, slo);
      lock.slos[existing.id] = slo;
      stats.updated++;
      return existing.id;
    } else {
      console.log(` - Creating ${slo.name}`);
      const res = await client.createSLO(slo);
      lock.slos[res.id] = res;
      stats.created++;
      return res.id;
    }
  }

  function addAletGraph(app: App, monitorID: number, monitor: Monitor) {
    app.addWidget("Alert: " + monitor.name, {
      type: "alert_graph",
      alert_id: monitorID.toString(),
      viz_type: "timeseries"
    });
  }

  async function pushMonitors(app: App, stats: pushStats) {
    let outageMonitorIDs: number[] = [];

    for (const syn of app.synthetics) {
      await pushSynthetic(syn, app.name, stats);

      // the api filter doesnt work, searching within the api call
      const syntheticMonitor = (
        await client.getMonitors("[Synthetics] " + syn.name)
      ).filter(
        d =>
          d.tags &&
          d.tags.find(t => t == createdbyTag) &&
          d.name == "[Synthetics] " + syn.name
      );

      if (syntheticMonitor.length == 1) {
        outageMonitorIDs.push(syntheticMonitor[0].id);
      }
    }
    var pushedMonitorID: number;

    for (const monitor of app.warningMonitors) {
      pushedMonitorID = await pushMonitor(monitor, app.name, stats);

      if (monitor.tags.find(d => d == generateAlertGraphTag)) {
        addAletGraph(app, pushedMonitorID, monitor);
      }
    }

    for (const monitor of app.outageMonitors) {
      pushedMonitorID = await pushMonitor(monitor, app.name, stats);
      outageMonitorIDs.push(pushedMonitorID);

      if (monitor.tags.find(d => d == generateAlertGraphTag)) {
        addAletGraph(app, pushedMonitorID, monitor);
      }
    }

    var sloID = "";
    if (outageMonitorIDs.length > 0) {
      sloID = await pushSLO(
        {
          type: "monitor",
          name: `${app.name} SLO`,
          description: `Track the uptime of ${app.name} ` + app.team.slackGroup,
          monitor_ids: outageMonitorIDs,
          thresholds: [{ timeframe: "30d", target: 99.9, warning: 99.95 }],
          tags: [`service:${app.name}`, createdbyTag]
        },
        app.name,
        stats
      );

      app.board.widgets.unshift({
        definition: {
          viz: "slo",
          type: "slo",
          slo_id: sloID,
          title: `${app.name} SLO`,
          time_windows: ["30d"],
          show_error_budget: true,
          view_type: "detail",
          view_mode: "overall"
        }
      });
    }
  }

  console.log("Pushing local changes to DataDog...");
  console.time("   ...completed in");

  var stats: pushStats = { skipped: 0, updated: 0, created: 0, deleted: 0 };

  for (const app of apps.default) {
    if (
      args.argv.name &&
      args.argv.name.toLowerCase() !== app.board.title.toLowerCase()
      //&& (getAppModifiedDate(d.name) > new Date(d.modified))
    ) {
      continue;
    }
    await pushMonitors(app, stats);
    await pushDashboard(app, stats);
  }

  if (!args.argv.name) {
    for (const d of dashboards.filter(d => !d.seen)) {
      console.log(` - Deleting dashboard ${d.title}`);
      await client.deleteDashboard(d.id);
      stats.deleted++;
    }

    for (const d of monitors.filter(
      d => !d.seen && !d.name.includes("[Synthetics]")
    )) {
      console.log(` - Deleting monitor ${d.name}`);
      await client.deleteMonitor(d.id);
      stats.deleted++;
    }

    for (const d of slos.filter(d => !d.seen)) {
      console.log(` - Deleting slo ${d.name}`);
      await client.deleteSLO(d.id);
      stats.deleted++;
    }

    for (const d of synthetics.filter(d => !d.seen)) {
      console.log(` - Deleting synthetic ${d.name}`);
      await client.deleteSynthetic(d.public_id);
      stats.deleted++;
    }
  }
  //console.log(lock)
  fs.writeFileSync("lock.json", JSON.stringify(lock));
  console.log(`Object statstics =`, stats);
  console.timeEnd("   ...completed in");
})();
