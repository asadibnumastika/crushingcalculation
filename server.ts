import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { createServer as createViteServer } from "vite";

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

interface RmiScrapeResult {
  caneYardTruck: number;
  caneYardTonage: number;
  totalAllTruck: number;
  totalAllTonage: number;
  checkpointTruck: number;
  parkingAreaTruck: number;
  engkelCy: number;
  fusoCy: number;
  doubleCy: number;
  todayTarget: number;
  todayCrushed: number;
  remainingTarget: number;
  remainingHour: string;
  hourlyTarget: number;
  shift1Tonage?: number;
  shift1Ton?: number;
  shift1Truck?: number;
  shift2Tonage?: number;
  shift2Ton?: number;
  shift2Truck?: number;
  shift3Tonage?: number;
  shift3Ton?: number;
  shift3Truck?: number;
  totalCrushedTruck?: number;
  rmiServerTime: string;
  fetchedAt: string;
  source: string;
}

// In-memory cache to prevent excessive requests to RMI server
let cachedRmiData: RmiScrapeResult | null = null;
let lastFetchTime = 0;
const CACHE_TTL_MS = 10_000; // 10 seconds cache

async function fetchRmiCaneYard(
  uname = "mill",
  passwd = "rmi_2021",
  force = false
): Promise<RmiScrapeResult> {
  const now = Date.now();
  if (!force && cachedRmiData && now - lastFetchTime < CACHE_TTL_MS) {
    return cachedRmiData;
  }

  const cookieJar = new Map<string, string>();
  function updateCookies(res: Response) {
    const raw = res.headers.get("set-cookie");
    if (raw) {
      // Split on cookie delimiters while avoiding comma in expiration dates
      const parts = raw.split(/,(?=[a-zA-Z0-9_]+=)/);
      for (const p of parts) {
        const c = p.split(";")[0].trim();
        const eqIdx = c.indexOf("=");
        if (eqIdx !== -1) {
          cookieJar.set(c.slice(0, eqIdx), c.slice(eqIdx + 1));
        }
      }
    }
  }

  function getCookieHeader(): string {
    return Array.from(cookieJar.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }

  // 1. Initial GET to obtain session cookie & CSRF tokens
  const r1 = await fetch("https://apps.rejosomanisindo.com/auth", {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    },
  });
  updateCookies(r1);
  const h1 = await r1.text();
  const hidden1 = [
    ...h1.matchAll(
      /<input type=['"]hidden['"] name=['"]([^'"]+)['"] value=['"]([^'"]+)['"]/g
    ),
  ];

  // 2. POST /auth/authcheck/ with credentials
  const p1 = new URLSearchParams();
  p1.append("uname", uname);
  p1.append("passwd", passwd);
  for (const m of hidden1) {
    p1.append(m[1], m[2]);
  }

  const r2 = await fetch("https://apps.rejosomanisindo.com/auth/authcheck/", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: getCookieHeader(),
      Referer: "https://apps.rejosomanisindo.com/auth",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
    body: p1.toString(),
    redirect: "follow",
  });
  updateCookies(r2);
  const h2 = await r2.text();

  if (h2.includes("errorMessage") && h2.includes("Wrong username")) {
    throw new Error("Username atau Password RMI salah.");
  }

  // 3. POST /auth/modulesetter with module=crushingmonitor
  const hidden2 = [
    ...h2.matchAll(
      /<input type=['"]hidden['"] name=['"]([^'"]+)['"] value=['"]([^'"]+)['"]/g
    ),
  ];
  const p2 = new URLSearchParams();
  p2.append("module", "crushingmonitor");
  for (const m of hidden2) {
    p2.append(m[1], m[2]);
  }

  const r3 = await fetch("https://apps.rejosomanisindo.com/auth/modulesetter", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: getCookieHeader(),
      Referer: "https://apps.rejosomanisindo.com/auth/moduleselector",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
    body: p2.toString(),
    redirect: "follow",
  });
  updateCookies(r3);
  const finalHtml = await r3.text();

  // Parse total_cy and cane yard details
  const totalCyMatch = finalHtml.match(
    /class=['"][^'"]*total_cy[^'"]*['"][^>]*>\s*([0-9.]+)\s*<\/td>/i
  );
  const totalEtpaMatch = finalHtml.match(
    /class=['"][^'"]*total_etpa[^'"]*['"][^>]*>\s*([0-9.]+)\s*<\/td>/i
  );
  const totalAllMatch = finalHtml.match(
    /class=['"][^'"]*total_all[^'"]*['"][^>]*>\s*([0-9.]+)\s*<\/td>/i
  );
  const engkelCyMatch = finalHtml.match(
    /class=['"][^'"]*engkel_cy[^'"]*['"][^>]*>\s*([0-9.]+)\s*<\/td>/i
  );
  const fusoCyMatch = finalHtml.match(
    /class=['"][^'"]*fuso_cy[^'"]*['"][^>]*>\s*([0-9.]+)\s*<\/td>/i
  );
  const doubleCyMatch = finalHtml.match(
    /class=['"][^'"]*dt_cy[^'"]*['"][^>]*>\s*([0-9.]+)\s*<\/td>/i
  );
  const checkpointMatch = finalHtml.match(
    /class=['"][^'"]*t_cp[^'"]*['"][^>]*>\s*([0-9.]+)\s*<\/td>/i
  );
  const parkingAreaMatch = finalHtml.match(
    /class=['"][^'"]*t_pa[^'"]*['"][^>]*>\s*([0-9.]+)\s*<\/td>/i
  );
  const timeMatch = finalHtml.match(
    /id=['"]ts-table-time['"][^>]*>\s*#?\s*([0-9:]+\s*[AP]M)\s*<\/div>/i
  );

  const caneYardTruck = totalCyMatch ? parseFloat(totalCyMatch[1]) : 0;
  const caneYardTonage = totalEtpaMatch ? parseFloat(totalEtpaMatch[1]) : 0;
  const totalAllTruck = totalAllMatch ? parseFloat(totalAllMatch[1]) : 0;

  // Approximate total tonage if not directly captured
  const totalAllTonageMatch = finalHtml.match(
    /<td[^>]*class=['"]table-danger text-center['"][^>]*>\s*([0-9.]+)\s*<\/td>/i
  );
  const totalAllTonage = totalAllTonageMatch
    ? parseFloat(totalAllTonageMatch[1])
    : 0;

  // Parse today target & crushed performance
  const targetTableMatch = finalHtml.match(
    /TODAY TARGET[\s\S]*?TODAY CRUSHED[\s\S]*?<tr[^>]*>\s*<th[^>]*>[^<]*<\/th>\s*<td>\s*([0-9.,]+)\s*<\/td>\s*<td>\s*([0-9.,]+)\s*<\/td>\s*<td>\s*([0-9.,]+)\s*<\/td>\s*<td>\s*([0-9:]+)\s*<\/td>\s*<td>\s*([0-9.,]+)\s*<\/td>/i
  );

  const todayTarget = targetTableMatch
    ? parseFloat(targetTableMatch[1].replace(/,/g, ""))
    : 10000;
  const todayCrushed = targetTableMatch
    ? parseFloat(targetTableMatch[2].replace(/,/g, ""))
    : 0;
  const remainingTarget = targetTableMatch
    ? parseFloat(targetTableMatch[3].replace(/,/g, ""))
    : 0;
  const remainingHour = targetTableMatch ? targetTableMatch[4].trim() : "00:00";
  const hourlyTarget = targetTableMatch
    ? parseFloat(targetTableMatch[5].replace(/,/g, ""))
    : 0;

  // Parse Shift Totals from Table 4
  const shiftTotalMatch = finalHtml.match(
    /<th[^>]*>TOTAL<\/th>\s*<th[^>]*>([0-9.,]+)<\/th>\s*<th[^>]*>([0-9.,]+)<\/th>\s*<th[^>]*>TOTAL<\/t[dh]>\s*<th[^>]*>([0-9.,]+)<\/th>\s*<th[^>]*>([0-9.,]+)<\/th>\s*<th[^>]*>TOTAL<\/th>\s*<th[^>]*>([0-9.,]+)<\/th>\s*<th[^>]*>([0-9.,]+)<\/th>/i
  );
  const totalTruckMatch = finalHtml.match(
    /<th[^>]*>TOTAL ALL\s*<\/th>\s*<th[^>]*>[0-9.,]+<\/th>\s*<th[^>]*>[0-9.,]+<\/th>[\s\S]*?<th[^>]*>([0-9.,]+)<\/th>\s*<th[^>]*>([0-9.,]+)<\/th>\s*<\/tr>/i
  );

  const rawS1A = shiftTotalMatch ? parseFloat(shiftTotalMatch[1].replace(/,/g, "")) : 0;
  const rawS1B = shiftTotalMatch ? parseFloat(shiftTotalMatch[2].replace(/,/g, "")) : 0;
  const rawS2A = shiftTotalMatch ? parseFloat(shiftTotalMatch[3].replace(/,/g, "")) : 0;
  const rawS2B = shiftTotalMatch ? parseFloat(shiftTotalMatch[4].replace(/,/g, "")) : 0;
  const rawS3A = shiftTotalMatch ? parseFloat(shiftTotalMatch[5].replace(/,/g, "")) : 0;
  const rawS3B = shiftTotalMatch ? parseFloat(shiftTotalMatch[6].replace(/,/g, "")) : 0;

  // Determine which is tonage and which is truck count (Tonage is ~8.9x truck count)
  let shift1Truck = 0;
  let shift1Tonage = 0;
  if (rawS1A > rawS1B && rawS1A > 500) {
    shift1Tonage = rawS1A;
    shift1Truck = rawS1B;
  } else if (rawS1B > rawS1A && rawS1B > 500) {
    shift1Tonage = rawS1B;
    shift1Truck = rawS1A;
  } else {
    shift1Tonage = rawS1A;
    shift1Truck = rawS1B;
  }
  if (shift1Tonage === 0 && shift1Truck > 0) {
    shift1Tonage = Math.round(shift1Truck * 8.9 * 100) / 100;
  }

  let shift2Truck = 0;
  let shift2Tonage = 0;
  if (rawS2A > rawS2B && rawS2A > 500) {
    shift2Tonage = rawS2A;
    shift2Truck = rawS2B;
  } else if (rawS2B > rawS2A && rawS2B > 500) {
    shift2Tonage = rawS2B;
    shift2Truck = rawS2A;
  } else {
    shift2Tonage = rawS2A;
    shift2Truck = rawS2B;
  }
  if (shift2Tonage === 0 && shift2Truck > 0) {
    shift2Tonage = Math.round(shift2Truck * 8.9 * 100) / 100;
  }

  let shift3Truck = 0;
  let shift3Tonage = 0;
  if (rawS3A > rawS3B && rawS3A > 500) {
    shift3Tonage = rawS3A;
    shift3Truck = rawS3B;
  } else if (rawS3B > rawS3A && rawS3B > 500) {
    shift3Tonage = rawS3B;
    shift3Truck = rawS3A;
  } else {
    shift3Tonage = rawS3A;
    shift3Truck = rawS3B;
  }
  if (shift3Tonage === 0 && shift3Truck > 0) {
    shift3Tonage = Math.round(shift3Truck * 8.9 * 100) / 100;
  }

  const parsedTotalTruck = totalTruckMatch ? parseFloat(totalTruckMatch[2].replace(/,/g, "")) : 0;
  const totalCrushedTruck = parsedTotalTruck > 0 ? parsedTotalTruck : (shift1Truck + shift2Truck + shift3Truck);

  const result: RmiScrapeResult = {
    caneYardTruck,
    caneYardTonage,
    totalAllTruck,
    totalAllTonage,
    checkpointTruck: checkpointMatch ? parseFloat(checkpointMatch[1]) : 0,
    parkingAreaTruck: parkingAreaMatch ? parseFloat(parkingAreaMatch[1]) : 0,
    engkelCy: engkelCyMatch ? parseFloat(engkelCyMatch[1]) : 0,
    fusoCy: fusoCyMatch ? parseFloat(fusoCyMatch[1]) : 0,
    doubleCy: doubleCyMatch ? parseFloat(doubleCyMatch[1]) : 0,
    todayTarget,
    todayCrushed,
    remainingTarget,
    remainingHour,
    hourlyTarget,
    shift1Tonage,
    shift1Ton: shift1Tonage,
    shift1Truck,
    shift2Tonage,
    shift2Ton: shift2Tonage,
    shift2Truck,
    shift3Tonage,
    shift3Ton: shift3Tonage,
    shift3Truck,
    totalCrushedTruck,
    rmiServerTime: timeMatch ? timeMatch[1].trim() : "",
    fetchedAt: new Date().toISOString(),
    source: "https://apps.rejosomanisindo.com/crushingmonitor/mdc",
  };

  cachedRmiData = result;
  lastFetchTime = Date.now();
  return result;
}

// -------------------------------------------------------------
// API ROUTES
// -------------------------------------------------------------
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Live Cane Yard Stock Endpoint
app.all("/api/rmi/live-stock", async (req, res) => {
  try {
    const uname = (req.query.uname || req.body?.uname || "mill") as string;
    const passwd = (req.query.passwd || req.body?.passwd || "rmi_2021") as string;
    const force = req.query.force === "true" || req.body?.force === true;

    const data = await fetchRmiCaneYard(uname, passwd, force);
    res.json({
      success: true,
      data,
    });
  } catch (err: any) {
    console.error("Error fetching RMI Cane Yard data:", err);
    res.status(500).json({
      success: false,
      error: err.message || "Gagal menghubungkan ke portal RMI.",
    });
  }
});

// -------------------------------------------------------------
// VITE OR STATIC SERVING
// -------------------------------------------------------------
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`SCADA Milling Train Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
