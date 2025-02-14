import * as cheerio from "cheerio";
import { decrypt } from "./helpers/decoder";

let BASEDOM = "https://whisperingauroras.com";

interface Servers {
  name: string | null;
  dataHash: string | null;
}

interface APIResponse {
  name: string | null;
  image: string | null;
  mediaId: string | null;
  stream: string | null;
  referer: string;
}

interface RCPResponse {
  metadata: {
    image: string;
  };
  data: string;
}

async function serversLoad(html: string): Promise<{ servers: Servers[]; title: string }> {
  const $ = cheerio.load(html);
  const servers: Servers[] = [];
  const title = $("title").text() ?? "";

  // Grab the iframe src attribute (if available)
  const baseAttr = $("iframe").attr("src");
  if (baseAttr && baseAttr.trim() !== "") {
    try {
      let constructedUrl = "";
      // If the src already starts with http or https, use it directly.
      if (baseAttr.startsWith("http://") || baseAttr.startsWith("https://")) {
        constructedUrl = baseAttr;
      } else if (baseAttr.startsWith("//")) {
        // Prepend "https:" if it starts with "//"
        constructedUrl = "https:" + baseAttr;
      } else {
        // Otherwise, the format is unexpected – throw an error.
        throw new Error("Unexpected iframe src format: " + baseAttr);
      }
      // Attempt to construct a URL
      const parsedUrl = new URL(constructedUrl);
      BASEDOM = parsedUrl.origin;
    } catch (err) {
      console.error("Error constructing BASEDOM from iframe src:", err);
      // Optionally, you can decide to keep the default BASEDOM or handle the error differently.
    }
  } else {
    console.error("No valid iframe src found, using default BASEDOM:", BASEDOM);
  }

  $(".serversList .server").each((index, element) => {
    const server = $(element);
    servers.push({
      name: server.text().trim(),
      dataHash: server.attr("data-hash") ?? null,
    });
  });

  return { servers, title };
}

async function PRORCPhandler(prorcp: string): Promise<string | null> {
  const prorcpFetch = await fetch(`${BASEDOM}/prorcp/${prorcp}`);
  const prorcpResponse = await prorcpFetch.text();

  const scripts = prorcpResponse.match(/<script\s+src="\/([^"]*\.js)\?\_=([^"]*)"><\/script>/gm);
  const script = (scripts?.[scripts.length - 1].includes("cpt.js"))
    ? scripts?.[scripts.length - 2].replace(/.*src="\/([^"]*\.js)\?\_=([^"]*)".*/, "$1?_=$2")
    : scripts?.[scripts.length - 1].replace(/.*src="\/([^"]*\.js)\?\_=([^"]*)".*/, "$1?_=$2");

  const jsFileReq = await fetch(`${BASEDOM}/${script}`, {
    headers: {
      accept: "*/*",
      "accept-language": "en-US,en;q=0.9",
      priority: "u=1",
      "sec-ch-ua": `"Chromium";v="128", "Not;A=Brand";v="24", "Google Chrome";v="128"`,
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": `"Windows"`,
      "sec-fetch-dest": "script",
      "sec-fetch-mode": "no-cors",
      "sec-fetch-site": "same-origin",
      Referer: `${BASEDOM}/`,
      "Referrer-Policy": "origin",
    },
    method: "GET",
  });

  const jsCode = await jsFileReq.text();
  const decryptRegex = /{}\}window\[([^"]+)\("([^"]+)"\)/;
  const decryptMatches = jsCode.match(decryptRegex);

  const $ = cheerio.load(prorcpResponse);
  if (!decryptMatches || decryptMatches.length < 3) return null;

  const id = decrypt(decryptMatches[2].toString().trim(), decryptMatches[1].toString().trim());
  const data = $("#" + id);
  const result = await decrypt(await data.text(), decryptMatches[2].toString().trim());
  return result;
}

async function rcpGrabber(html: string): Promise<RCPResponse | null> {
  const regex = /src:\s*'([^']*)'/;
  const match = html.match(regex);
  if (!match) return null;
  return {
    metadata: {
      image: "",
    },
    data: match[1],
  };
}

async function tmdbScrape(tmdbId: string, type: "movie" | "tv", season?: number, episode?: number) {
  if (season && episode && type === "movie") {
    throw new Error("Invalid Data.");
  }
  if (!tmdbId || (season && !episode)) {
    throw new Error("Invalid tmdbId or season/episode data");
  }

  const url = type === "movie"
    ? `https://vidsrc.net/embed/${type}?tmdb=${tmdbId}`
    : `https://vidsrc.net/embed/${type}?tmdb=${tmdbId}&season=${season}&episode=${episode}`;

  console.log("Generated URL for tmdbScrape:", url);

  try {
    const embed = await fetch(url);
    const embedResp = await embed.text();

    // Get metadata from embed response
    const { servers, title } = await serversLoad(embedResp);

    const rcpFetchPromises = servers.map((element) => {
      return fetch(`${BASEDOM}/rcp/${element.dataHash}`);
    });
    const rcpResponses = await Promise.all(rcpFetchPromises);

    const prosrcrcp = await Promise.all(
      rcpResponses.map(async (response) => {
        return rcpGrabber(await response.text());
      })
    );

    const apiResponse: APIResponse[] = [];
    for (const item of prosrcrcp) {
      if (!item) continue;
      if (item.data.substring(0, 8) === "/prorcp/") {
        apiResponse.push({
          name: title,
          image: item.metadata.image,
          mediaId: tmdbId,
          stream: await PRORCPhandler(item.data.replace("/prorcp/", "")),
          referer: BASEDOM,
        });
      }
    }
    return apiResponse;
  } catch (error) {
    console.error("Error in tmdbScrape with URL:", url, error);
    throw new Error("Error in tmdbScrape function.");
  }
}

export default tmdbScrape;
