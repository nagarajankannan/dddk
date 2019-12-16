import * as api from "./src/api";
import { App, descriptionTag } from "./src/app";
import * as yargs from "yargs";
import * as path from "path";
import { Monitor, SLO, Synthetic } from "./src/api";

const args = yargs
  .command("push <apps>", "push datadog dashboards up")
  .option("name", {
    type: "string",
    description: "only push the matching app name"
  })
  .demandCommand();

const appFile = path.resolve(args.argv.apps as string);
const apps = require(appFile);

if (!process.env["DD_API_KEY"] || !process.env["DD_APP_KEY"]) {
  console.error(
    "MISSING API KEYS - run again using \n" +
      "  aws-vault exec platform -- chamber exec ddac -- npm run sync\n\n"
  );
  process.exit(1);
}

const client = new api.Client(
  process.env["DD_API_KEY"],
  process.env["DD_APP_KEY"]
);

(async () => {
  const dashboards = (await client.getDashboards()).filter(
    d => d.description && d.description.includes(descriptionTag)
  );
  const monitors = (await client.getMonitors()).filter(
    d => d.tags && d.tags.find(t => t == "created_by:ddac")
  );
  const slos = (await client.getSLOs()).filter(
    d => d.tags && d.tags.find(t => t == "created_by:ddac")
  );
  const synthetics = (await client.getSynthetics()).filter(
    d => d.tags && d.tags.find(t => t == "created_by:ddac")
  );

  async function pushDashboard(app: App) {
    const existing = dashboards.find(d => d.title == app.board.title);

    if (existing) {
      console.log(` - Updating dashboard ${app.board.title}`);
      await client.updateDashboard(existing.id, app.board);
    } else {
      console.log(` - Creating dashboard ${app.board.title}`);
      await client.createDashboard(app.board);
    }
  }

  async function pushMonitor(monitor: Monitor): Promise<number> {
    const existing = monitors.find(d => d.name == monitor.name);

    if (existing) {
      console.log(` - Updating monitor ${monitor.name}`);
      await client.updateMonitor(existing.id, monitor);
      return existing.id;
    } else {
      console.log(` - Creating monitor ${monitor.name}`);
      const res = await client.createMonitor(monitor);
      return res.id;
    }
  }

  async function pushSynthetic(syn: Synthetic) {
    const existing = synthetics.find(d => d.name == syn.name);

    if (existing) {
      console.log(` - Updating synthetic ${syn.name}`);
      await client.updateSynthetic(existing.public_id, syn);
      return existing.public_id;
    } else {
      console.log(` - Creating synthetic ${syn.name}`);
      const res = await client.createSynthetic(syn);
      return res.public_id;
    }
  }

  async function pushSLO(slo: SLO) {
    const existing = slos.find(d => d.name == slo.name);

    if (existing) {
      console.log(` - Updating ${slo.name}`);
      await client.updateSLO(existing.id, slo);
      return existing.id;
    } else {
      console.log(` - Creating ${slo.name}`);
      const res = await client.createSLO(slo);
      return res.id;
    }
  }

  async function pushMonitors(app: App) {
    let outageMonitors: number[] = [];
    for (const syn of app.synthetics) {
      await pushSynthetic(syn);

      // the api filter doesnt work.
      const syntheticMonitor = (await client.getMonitors()).filter(
        d =>
          d.tags &&
          d.tags.find(t => t == "created_by:ddac") &&
          d.name == "[Synthetics] " + syn.name
      );

      if (syntheticMonitor.length == 1) {
        outageMonitors.push(syntheticMonitor[0].id);
      }
    }

    for (const monitor of app.warningMonitors) {
      await pushMonitor(monitor);
    }

    for (const monitor of app.outageMonitors) {
      outageMonitors.push(await pushMonitor(monitor));
    }
    if (outageMonitors.length > 0) {
      await pushSLO({
        type: "monitor",
        name: `${app.name} SLO`,
        description: `Track the uptime of ${app.name}`,
        monitor_ids: outageMonitors,
        thresholds: [{ timeframe: "30d", target: 99, warning: 99.9 }],
        tags: [`service:${app.name}`, "created_by:ddac"]
      });
    }
  }

  for (const app of apps.default) {
    if (
      args.argv.name &&
      args.argv.name.toLowerCase() !== app.board.title.toLowerCase()
    ) {
      continue;
    }
    await pushMonitors(app);
    await pushDashboard(app);
  }
  console.log("done!");
})();
