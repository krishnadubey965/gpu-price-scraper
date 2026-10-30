# GPU Price Scraper - Vast.ai & RunPod Cloud GPU Rentals

Track what an hour of cloud GPU compute actually costs. This Actor pulls live rental prices for **H100, A100, RTX 4090, L40S** and 45+ more GPU models from **Vast.ai** and **RunPod**, and returns them as one normalised table, so you can compare the same GPU across providers, regions and price types — on-demand or interruptible.

No login, no API key, no proxy — both providers publish this data openly.

## Why

The same GPU can cost three times more on one provider than another, and prices move daily. There is no single place to see them side by side, so teams either overpay or keep a spreadsheet by hand. This Actor replaces the spreadsheet.

## What you get

One row per offer, with the comparable price (`pricePerGpuHourUsd`) already worked out:

| Field | Meaning |
| --- | --- |
| `gpuModel` | GPU name as the provider spells it |
| `pricePerGpuHourUsd` | **Hourly price per single GPU** — the number to compare |
| `pricePerHourUsd` | Total hourly price of the offer |
| `provider` | `vast.ai` or `runpod` |
| `priceType` | `marketplace`, `on-demand` or `spot` |
| `numGpus`, `vramGbPerGpu` | Machine size |
| `cpuRamGb`, `cpuCores`, `diskSpaceGb` | Host specs (Vast.ai) |
| `internetDownMbps`, `internetUpMbps` | Network speed (Vast.ai) |
| `reliability` | Host reliability 0-1 (Vast.ai) |
| `dlPerf`, `dlPerfPerDollar` | Performance score and value score (Vast.ai) |
| `location` | Where the machine sits |

Rows arrive sorted cheapest first.

## Input

| Field | Type | Description |
| --- | --- | --- |
| `sources` | array | `vast.ai`, `runpod`, or both (default) |
| `gpuModels` | array | Model names like `RTX 4090`, `H100 SXM`. Empty discovers what is on the market right now |
| `onlyCheapestPerModel` | boolean | Keep one cheapest row per provider + model + price type. Use this for a price index |
| `maxPricePerHourUsd` | integer | Drop offers above this price |
| `minVramGb` | integer | Drop GPUs with less memory than this |
| `maxItems` | integer | Row cap (default 500) |

### Example input

```json
{
    "sources": ["vast.ai", "runpod"],
    "gpuModels": ["RTX 4090", "H100 SXM"],
    "onlyCheapestPerModel": true,
    "maxItems": 100
}
```

### Example output

```json
{
    "provider": "vast.ai",
    "priceType": "marketplace",
    "gpuModel": "RTX 4090",
    "numGpus": 8,
    "vramGbPerGpu": 24,
    "pricePerHourUsd": 0.9616,
    "pricePerGpuHourUsd": 0.1202,
    "reliability": 0.9834,
    "dlPerfPerDollar": 72.72,
    "location": "Texas, US",
    "scrapedAt": "2026-10-29T09:12:04.118Z"
}
```

## Uses

- **Cost control** — see whether your current provider is still competitive before the next training run
- **Price monitoring** — schedule it daily with `onlyCheapestPerModel` to build a GPU price index over time
- **Capacity hunting** — find who actually has H100s available, and where
- **Value shopping** — sort by `dlPerfPerDollar` instead of raw price

## Notes and limits

- Vast.ai returns at most 64 offers per query, so the Actor queries one GPU model at a time to get real coverage. Listing many models means more requests and a longer run.
- RunPod publishes one price per GPU type rather than per machine, so RunPod rows have no host specs, location or reliability.
- Prices are what the providers advertise at the moment of the run. Marketplace offers can disappear between the run and your booking.
- Spelling matters: `H100 SXM` and `H100 PCIE` are different models to the providers.

## FAQ

**Do I need an account with either provider?**
No. Both endpoints are public.

**How often should I run it?**
Daily is enough for a price index. Marketplace supply shifts within hours, so run it right before booking if you are hunting for a specific machine.

**Can you add more providers?**
Lambda, Together and CoreWeave are the obvious next ones. Open an issue on the Actor if you need a particular provider.
