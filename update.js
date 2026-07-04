const fs = require("fs");

const CLIENT_ID = process.env.SIMKL_CLIENT_ID;
const ACCESS_TOKEN = process.env.SIMKL_ACCESS_TOKEN;

const APP_NAME = "d3ofi-watching-widget";
const APP_VERSION = "1.0";

if (!CLIENT_ID || !ACCESS_TOKEN) {
  throw new Error("Missing SIMKL_CLIENT_ID or SIMKL_ACCESS_TOKEN secrets.");
}

const BASE = "https://api.simkl.com/sync/all-items";

function endpoint(type) {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    "app-name": APP_NAME,
    "app-version": APP_VERSION,
    language: "en",
    next_watch_info: "yes"
  });

  return `${BASE}/${type}?${params.toString()}`;
}

async function getSimkl(type) {
  const response = await fetch(endpoint(type), {
    headers: {
      "Authorization": `Bearer ${ACCESS_TOKEN}`,
      "User-Agent": `${APP_NAME}/${APP_VERSION}`
    }
  });

  if (!response.ok) {
    throw new Error(`Simkl ${type} request failed: ${response.status}`);
  }

  return response.json();
}

function flattenItems(data, type) {
  const out = [];

  if (Array.isArray(data)) {
    data.forEach(item => out.push({ ...item, simkl_type: type }));
    return out;
  }

  if (!data || typeof data !== "object") return out;

  Object.entries(data).forEach(([status, value]) => {
    if (Array.isArray(value)) {
      value.forEach(item => {
        out.push({
          ...item,
          status,
          simkl_type: type
        });
      });
    }
  });

  return out;
}

function getMedia(item) {
  return item.show || item.movie || item.anime || item;
}

function getTitle(item) {
  const media = getMedia(item);
  return media.title || media.name || item.title || item.name || "unknown title";
}

function getTypeLabel(item) {
  if (item.simkl_type === "shows") return "tv show";
  if (item.simkl_type === "movies") return "movie";
  if (item.simkl_type === "anime") return "anime";
  return "watching";
}

function collectDates(obj, dates = []) {
  if (!obj || typeof obj !== "object") return dates;

  for (const [key, value] of Object.entries(obj)) {
    if (
      typeof value === "string" &&
      /watched|last/i.test(key) &&
      !value.startsWith("1970-")
    ) {
      const time = Date.parse(value);
      if (!Number.isNaN(time)) {
        dates.push(value);
      }
    }

    if (value && typeof value === "object") {
      collectDates(value, dates);
    }
  }

  return dates;
}

function newestDate(item) {
  const dates = collectDates(item);

  if (!dates.length) return "";

  return dates
    .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0];
}

function episodeLine(item) {
  const next = item.next_to_watch_info;

  if (next && (next.season || next.episode || next.title)) {
    const s = next.season ? `S${String(next.season).padStart(2, "0")}` : "";
    const e = next.episode ? `E${String(next.episode).padStart(2, "0")}` : "";
    const ep = `${s}${e}`;
    const title = next.title ? ` · next: ${next.title}` : "";
    return ep ? `next ${ep}${title}` : `next${title}`;
  }

  if (item.watched_episodes_count && item.total_episodes_count) {
    return `${item.watched_episodes_count}/${item.total_episodes_count} episodes watched`;
  }

  return "";
}

function pickBestItem(items) {
  const watching = items.filter(item => item.status === "watching");

  const pool = watching.length ? watching : items;

  return pool
    .map(item => ({
      item,
      date: newestDate(item)
    }))
    .sort((a, b) => {
      const aTime = a.date ? new Date(a.date).getTime() : 0;
      const bTime = b.date ? new Date(b.date).getTime() : 0;
      return bTime - aTime;
    })[0];
}

async function main() {
  const all = [];

  for (const type of ["shows", "movies", "anime"]) {
    const data = await getSimkl(type);
    all.push(...flattenItems(data, type));
  }

  const best = pickBestItem(all);

  let output;

  if (!best || !best.item) {
    output = {
      title: "nothing tracked rn",
      subtitle: "",
      watched_at: "",
      meta: "from simkl"
    };
  } else {
    const item = best.item;

    output = {
      title: getTitle(item),
      subtitle: episodeLine(item) || getTypeLabel(item),
      watched_at: best.date || "",
      meta: item.status ? `simkl · ${item.status}` : "from simkl"
    };
  }

  fs.writeFileSync("watching.json", JSON.stringify(output, null, 2));
  console.log(output);
}

main().catch(error => {
  console.error(error);

  const fallback = {
    title: "nothing tracked rn",
    subtitle: "",
    watched_at: "",
    meta: "simkl unavailable"
  };

  fs.writeFileSync("watching.json", JSON.stringify(fallback, null, 2));
  process.exit(1);
});
