const fs = require("fs");

const CLIENT_ID = process.env.SIMKL_CLIENT_ID;
const ACCESS_TOKEN = process.env.SIMKL_ACCESS_TOKEN;

const APP_NAME = "d3ofi-watching-widget";
const APP_VERSION = "1.0";

const STATE_FILE = "simkl-state.json";
const OUTPUT_FILE = "watching.json";
const TYPES = ["shows", "movies", "anime"];

if (!CLIENT_ID || !ACCESS_TOKEN) {
  throw new Error("Missing SIMKL_CLIENT_ID or SIMKL_ACCESS_TOKEN.");
}

function readJSON(file, fallback) {
  if (!fs.existsSync(file)) return fallback;

  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function params(extra = {}) {
  return new URLSearchParams({
    client_id: CLIENT_ID,
    "app-name": APP_NAME,
    "app-version": APP_VERSION,
    language: "en",
    ...extra
  });
}

async function simkl(path, extra = {}) {
  const url = `https://api.simkl.com${path}?${params(extra)}`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      "User-Agent": `${APP_NAME}/${APP_VERSION}`
    }
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`${path} failed ${response.status}: ${text}`);
  }

  return text ? JSON.parse(text) : {};
}

function unwrap(data, type) {
  if (Array.isArray(data?.[type])) return data[type];
  if (Array.isArray(data)) return data;
  return [];
}

async function pullFullLibrary() {
  const cache = {
    shows: [],
    movies: [],
    anime: []
  };

  for (const type of TYPES) {
    const data = await simkl(`/sync/all-items/${type}`, {
      next_watch_info: "yes"
    });

    cache[type] = unwrap(data, type).map(item => ({
      ...item,
      _type: type
    }));

    console.log(`${type}: ${cache[type].length} items`);
  }

  return cache;
}

function getTitle(item) {
  return (
    item.show?.title ||
    item.movie?.title ||
    item.anime?.title ||
    item.title ||
    item.name ||
    "unknown title"
  );
}

function getKind(item) {
  if (item._type === "shows") return "tv show";
  if (item._type === "anime") return "anime";
  if (item._type === "movies") return "movie";
  return "watching";
}

function getStatus(item) {
  return (
    item.status ||
    item.user_status ||
    item.list_status ||
    item.watchlist_status ||
    ""
  );
}

function collectDates(obj, dates = []) {
  if (!obj || typeof obj !== "object") return dates;

  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string") {
      const lower = key.toLowerCase();

      const isUsefulDate =
        (
          lower.includes("last_watched") ||
          lower.includes("watched_at") ||
          lower.includes("watched") ||
          lower.includes("added_to_watchlist")
        ) &&
        !value.startsWith("1970-") &&
        !Number.isNaN(Date.parse(value));

      if (isUsefulDate) {
        dates.push({
          key,
          value,
          time: Date.parse(value)
        });
      }
    }

    if (value && typeof value === "object") {
      collectDates(value, dates);
    }
  }

  return dates;
}

function bestDate(item) {
  const dates = collectDates(item);

  const watchedDates = dates.filter(d =>
    d.key.toLowerCase().includes("watched")
  );

  const pool = watchedDates.length ? watchedDates : dates;

  return pool.sort((a, b) => b.time - a.time)[0]?.value || "";
}

function getSubtitle(item) {
  const status = getStatus(item);
  const next = item.next_to_watch_info;

  if (next) {
    const season = next.season ? `S${String(next.season).padStart(2, "0")}` : "";
    const episode = next.episode ? `E${String(next.episode).padStart(2, "0")}` : "";
    const ep = `${season}${episode}`;
    return ep ? `next ${ep}` : "currently watching";
  }

  if (status === "watching") return "currently watching";
  if (status === "completed") return "completed";
  if (status === "plantowatch") return "plan to watch";

  return getKind(item);
}

function pickBest(cache) {
  const all = [
    ...(cache.shows || []),
    ...(cache.movies || []),
    ...(cache.anime || [])
  ];

  console.log(`total items: ${all.length}`);

  if (!all.length) return null;

  const scored = all.map(item => {
    const status = getStatus(item);
    const date = bestDate(item);
    const time = date ? Date.parse(date) : 0;

    let priority = 0;

    if (status === "watching") priority += 100000000000000;
    if (date) priority += time;

    return {
      item,
      date,
      priority
    };
  });

  scored.sort((a, b) => b.priority - a.priority);

  return scored[0];
}

async function main() {
  const state = readJSON(STATE_FILE, {
    lastSync: "",
    cache: {
      shows: [],
      movies: [],
      anime: []
    }
  });

  const activities = await simkl("/sync/activities");

  const hasCache =
    state.cache &&
    (
      state.cache.shows?.length ||
      state.cache.movies?.length ||
      state.cache.anime?.length
    );

  if (!hasCache) {
    console.log("No local cache yet. Pulling full Simkl library...");
    state.cache = await pullFullLibrary();
    state.lastSync = activities.all || "";
  } else if (activities.all && activities.all !== state.lastSync) {
    console.log("Simkl changed. Refreshing library...");
    state.cache = await pullFullLibrary();
    state.lastSync = activities.all || "";
  } else {
    console.log("No Simkl changes. Using cached library.");
  }

  const best = pickBest(state.cache);

  let output;

  if (!best || !best.item) {
    output = {
      title: "nothing tracked rn",
      subtitle: "",
      watched_at: "",
      meta: "from simkl"
    };
  } else {
    const status = getStatus(best.item);

    output = {
      title: getTitle(best.item),
      subtitle: getSubtitle(best.item),
      watched_at: best.date || "",
      meta: status ? `simkl · ${status}` : `simkl · ${getKind(best.item)}`
    };
  }

  writeJSON(STATE_FILE, state);
  writeJSON(OUTPUT_FILE, output);

  console.log("watching.json:");
  console.log(output);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
