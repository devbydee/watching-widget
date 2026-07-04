const fs = require("fs");

const CLIENT_ID = process.env.SIMKL_CLIENT_ID;
const ACCESS_TOKEN = process.env.SIMKL_ACCESS_TOKEN;

const APP_NAME = "d3ofi-watching-widget";
const APP_VERSION = "1.0";

if (!CLIENT_ID || !ACCESS_TOKEN) {
  throw new Error("Missing SIMKL_CLIENT_ID or SIMKL_ACCESS_TOKEN secrets.");
}

const STATUSES = ["watching", "completed", "hold", "plantowatch"];
const TYPES = ["shows", "movies", "anime"];

function makeUrl(type, status) {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    "app-name": APP_NAME,
    "app-version": APP_VERSION,
    language: "en",
    next_watch_info: "yes"
  });

  return `https://api.simkl.com/sync/all-items/${type}/${status}?${params.toString()}`;
}

async function getItems(type, status) {
  const response = await fetch(makeUrl(type, status), {
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      "User-Agent": `${APP_NAME}/${APP_VERSION}`
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${type}/${status} failed: ${response.status} ${text}`);
  }

  const data = await response.json();

  if (!Array.isArray(data)) return [];

  return data.map(item => ({
    ...item,
    simkl_type: type,
    simkl_status: status
  }));
}

function getMedia(item) {
  return item.show || item.movie || item.anime || item;
}

function getTitle(item) {
  const media = getMedia(item);
  return media.title || media.name || item.title || item.name || "unknown title";
}

function findDate(item) {
  const candidates = [];

  function walk(obj) {
    if (!obj || typeof obj !== "object") return;

    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === "string") {
        const looksLikeDate =
          /watched|last|updated|added|aired/i.test(key) &&
          !value.startsWith("1970-") &&
          !Number.isNaN(Date.parse(value));

        if (looksLikeDate) candidates.push(value);
      }

      if (value && typeof value === "object") {
        walk(value);
      }
    }
  }

  walk(item);

  return candidates.sort((a, b) => new Date(b) - new Date(a))[0] || "";
}

function getSubtitle(item) {
  if (item.simkl_status === "watching") {
    const next = item.next_to_watch_info;

    if (next) {
      const season = next.season ? `S${String(next.season).padStart(2, "0")}` : "";
      const episode = next.episode ? `E${String(next.episode).padStart(2, "0")}` : "";
      const ep = `${season}${episode}`;
      return ep ? `next ${ep}` : "currently watching";
    }

    return "currently watching";
  }

  if (item.simkl_type === "movies") return "movie";
  if (item.simkl_type === "anime") return "anime";
  return "tv show";
}

function pickBest(items) {
  const watching = items.filter(item => item.simkl_status === "watching");

  const pool = watching.length ? watching : items;

  return pool
    .map(item => ({
      item,
      date: findDate(item)
    }))
    .sort((a, b) => {
      const at = a.date ? new Date(a.date).getTime() : 0;
      const bt = b.date ? new Date(b.date).getTime() : 0;
      return bt - at;
    })[0];
}

async function main() {
  const allItems = [];

  for (const type of TYPES) {
    for (const status of STATUSES) {
      try {
        const items = await getItems(type, status);
        allItems.push(...items);
      } catch (error) {
        console.log(`Skipped ${type}/${status}: ${error.message}`);
      }
    }
  }

  const best = pickBest(allItems);

  let output;

  if (!best || !best.item) {
    output = {
      title: "nothing tracked rn",
      subtitle: "",
      watched_at: "",
      meta: "from simkl"
    };
  } else {
    output = {
      title: getTitle(best.item),
      subtitle: getSubtitle(best.item),
      watched_at: best.date,
      meta: `simkl · ${best.item.simkl_status}`
    };
  }

  fs.writeFileSync("watching.json", JSON.stringify(output, null, 2));
  console.log(output);
}

main().catch(error => {
  console.error(error);

  fs.writeFileSync(
    "watching.json",
    JSON.stringify(
      {
        title: "nothing tracked rn",
        subtitle: "",
        watched_at: "",
        meta: "simkl unavailable"
      },
      null,
      2
    )
  );

  process.exit(1);
});
