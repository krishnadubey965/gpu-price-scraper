// GPU rental price scraper — Vast.ai marketplace + RunPod cloud.
//
// Both providers publish prices over open JSON endpoints, so this Actor needs
// no login, no API key and no proxy. Every row is normalised to the same shape
// so prices can be compared across providers and GPU models.
import { Actor, log } from 'apify';

await Actor.init();

const {
    gpuModels = [],
    sources = ['vast.ai', 'runpod'],
    onlyCheapestPerModel = false,
    maxPricePerHourUsd = null,
    minVramGb = null,
    maxItems = 500,
} = (await Actor.getInput()) ?? {};

const VAST_BUNDLES = 'https://console.vast.ai/api/v0/bundles/';
const RUNPOD_GRAPHQL = 'https://api.runpod.io/graphql';
// Vast.ai caps every response at 64 offers no matter what limit is asked for,
// so breadth comes from querying one GPU model at a time.
const VAST_PAGE_CAP = 64;

let pushed = 0;
let stopped = false;

Actor.on('aborting', async () => {
    stopped = true;
    log.info(`Abort requested — ${pushed} rows saved.`);
    await Actor.exit();
});

const budgetLeft = () => !stopped && pushed < maxItems;

const round = (n, places = 4) =>
    typeof n === 'number' && Number.isFinite(n) ? Number(n.toFixed(places)) : null;

const toInt = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n) : null;
};

async function fetchJson(url, options = {}, attempts = 3) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            const res = await fetch(url, {
                ...options,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; apify-gpu-price-scraper)',
                    Accept: 'application/json',
                    ...(options.headers ?? {}),
                },
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
        } catch (error) {
            if (attempt === attempts) throw error;
            const waitMs = 1000 * attempt;
            log.warning(`${url} failed (${error.message}); retry ${attempt}/${attempts - 1} in ${waitMs}ms`);
            await new Promise((resolve) => setTimeout(resolve, waitMs));
        }
    }
    return null;
}

const vastUrl = (query) => `${VAST_BUNDLES}?q=${encodeURIComponent(JSON.stringify(query))}`;

/** Vast.ai reports GPU and CPU memory in MB, disk in GB, price in USD per hour. */
const vastRow = (offer) => ({
    provider: 'vast.ai',
    priceType: 'marketplace',
    gpuModel: offer.gpu_name ?? null,
    numGpus: toInt(offer.num_gpus),
    vramGbPerGpu: offer.gpu_ram ? Math.round(offer.gpu_ram / 1024) : null,
    pricePerHourUsd: round(offer.dph_total),
    pricePerGpuHourUsd:
        offer.num_gpus > 0 ? round(offer.dph_total / offer.num_gpus) : round(offer.dph_total),
    cpuRamGb: offer.cpu_ram ? Math.round(offer.cpu_ram / 1024) : null,
    cpuCores: toInt(offer.cpu_cores),
    diskSpaceGb: round(offer.disk_space, 1),
    internetDownMbps: round(offer.inet_down, 1),
    internetUpMbps: round(offer.inet_up, 1),
    reliability: round(offer.reliability2, 4),
    verification: offer.verification ?? null,
    location: offer.geolocation ?? null,
    cudaVersion: offer.cuda_max_good ? String(offer.cuda_max_good) : null,
    dlPerf: round(offer.dlperf, 2),
    dlPerfPerDollar: round(offer.dlperf_per_dphtotal, 2),
    isRentable: offer.rentable === true,
    offerId: toInt(offer.id),
    machineId: toInt(offer.machine_id),
    url: 'https://cloud.vast.ai/create/',
    scrapedAt: new Date().toISOString(),
});

const runpodRow = (gpu, priceType, price) => ({
    provider: 'runpod',
    priceType,
    gpuModel: gpu.displayName ?? gpu.id ?? null,
    numGpus: 1,
    vramGbPerGpu: toInt(gpu.memoryInGb),
    pricePerHourUsd: round(price),
    pricePerGpuHourUsd: round(price),
    cpuRamGb: null,
    cpuCores: null,
    diskSpaceGb: null,
    internetDownMbps: null,
    internetUpMbps: null,
    reliability: null,
    verification: gpu.secureCloud ? 'secure-cloud' : 'community-cloud',
    location: null,
    cudaVersion: null,
    dlPerf: null,
    dlPerfPerDollar: null,
    isRentable: true,
    offerId: null,
    machineId: null,
    url: 'https://www.runpod.io/pricing',
    scrapedAt: new Date().toISOString(),
});

const passesFilters = (row) =>
    (maxPricePerHourUsd === null || (row.pricePerHourUsd ?? Infinity) <= maxPricePerHourUsd) &&
    (minVramGb === null || (row.vramGbPerGpu ?? 0) >= minVramGb);

const collected = [];

const collect = (row) => {
    if (!passesFilters(row)) return;
    collected.push(row);
};

// ---------------------------------------------------------------- Vast.ai
async function scrapeVast() {
    let models = gpuModels.map((m) => String(m).trim()).filter(Boolean);

    if (models.length === 0) {
        // No models requested: sample the marketplace from several angles, since
        // any single query only ever returns 64 rows.
        const discovered = new Set();
        for (const order of [
            [['dph_total', 'asc']],
            [['dph_total', 'desc']],
            [['num_gpus', 'desc']],
            [['dlperf_per_dphtotal', 'desc']],
        ]) {
            const data = await fetchJson(vastUrl({ order, limit: VAST_PAGE_CAP }));
            for (const offer of data?.offers ?? []) {
                if (offer.gpu_name) discovered.add(offer.gpu_name);
            }
        }
        models = [...discovered];
        log.info(`Vast.ai: discovered ${models.length} GPU models`);
    }

    for (const model of models) {
        if (!budgetLeft()) break;
        const data = await fetchJson(
            vastUrl({
                gpu_name: { eq: model },
                order: [['dph_total', 'asc']],
                limit: VAST_PAGE_CAP,
            }),
        );
        const offers = data?.offers ?? [];
        log.info(`Vast.ai ${model}: ${offers.length} offers`);
        for (const offer of offers) collect(vastRow(offer));
    }
}

// ---------------------------------------------------------------- RunPod
async function scrapeRunpod() {
    const query = `{
        gpuTypes {
            id
            displayName
            memoryInGb
            secureCloud
            communityCloud
            lowestPrice(input: { gpuCount: 1 }) {
                minimumBidPrice
                uninterruptablePrice
            }
        }
    }`;

    const data = await fetchJson(RUNPOD_GRAPHQL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
    });

    const gpus = data?.data?.gpuTypes ?? [];
    log.info(`RunPod: ${gpus.length} GPU types`);

    for (const gpu of gpus) {
        const onDemand = gpu.lowestPrice?.uninterruptablePrice;
        const spot = gpu.lowestPrice?.minimumBidPrice;
        if (typeof onDemand === 'number' && onDemand > 0) collect(runpodRow(gpu, 'on-demand', onDemand));
        if (typeof spot === 'number' && spot > 0) collect(runpodRow(gpu, 'spot', spot));
    }
}

// ---------------------------------------------------------------- run
const wanted = sources.map((s) => String(s).toLowerCase());

if (wanted.includes('vast.ai')) await scrapeVast();
if (wanted.includes('runpod')) await scrapeRunpod();

if (collected.length === 0) {
    log.warning('No offers matched. Check the GPU model spelling and the filters.');
}

let rows = collected;

if (onlyCheapestPerModel) {
    const cheapest = new Map();
    for (const row of rows) {
        const key = `${row.provider}|${row.gpuModel}|${row.priceType}`;
        const current = cheapest.get(key);
        if (!current || (row.pricePerGpuHourUsd ?? Infinity) < (current.pricePerGpuHourUsd ?? Infinity)) {
            cheapest.set(key, row);
        }
    }
    rows = [...cheapest.values()];
    log.info(`Reduced to ${rows.length} cheapest-per-model rows.`);
}

rows.sort((a, b) => (a.pricePerGpuHourUsd ?? Infinity) - (b.pricePerGpuHourUsd ?? Infinity));

for (const row of rows) {
    if (!budgetLeft()) break;
    await Actor.pushData(row);
    pushed += 1;
}

log.info(`Done. ${pushed} rows saved (from ${collected.length} collected).`);
await Actor.exit();
