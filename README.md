# SVG images keep hidden Chromium tabs busy

On Windows 11, a page that uses 10 or more distinct SVG images (8 stayed quiet) keeps every hidden tab's renderer main thread at 50–100% of a core for as long as the tabs stay hidden. Found in an Electron app (Electron 44.5.1 and 45.2.2, Chromium 156.0.8078.80, V8 15.6.75), reduced to this repro. Windows Server, macOS and Linux runners didn't show it.

## Run

```
npm install
npx electron . --repro-hidden=3 --repro-svgs=30 --repro-seconds=600
```

| Option | Default | |
|:--|:--|:--|
| `--repro-hidden=<n>` | 3 | Hidden tabs beside the visible one, each its own renderer |
| `--repro-svgs=<n>` | 30 | Distinct SVG images on each page |
| `--repro-seconds=<n>` | 720 | How long to sample once the tabs are hidden |
| `--repro-js-flags=<flags>` | – | V8 flags for the renderers |
| `--repro-switch=<name>[=<value>]` | – | A Chromium switch, repeatable |
| `--repro-kick=<n>` | 3 | Rounds of DOM + JS garbage in each hidden tab right after hiding, 5s apart, so its GC starts |
| `--repro-churn=<s>` | off | The same garbage every N seconds for the whole run. This spins even with few SVGs on a small machine, as each GC's sweep then spins |
| `--repro-cores=<n>` | all | Pins the app to the first N cores (Windows only) |
| `--repro-hogs=<n>` | 0 | Runs N busy processes beside it |
| `--repro-hog-seconds=<s>` | whole run | Stops the hogs after this long |

Every 10 seconds a line gives each tab's renderer CPU. The last line reads `repro: spin` or `repro: quiet`, judged on the last third of the samples. `results/` keeps the log and a JSON summary, including each tab's `document.hidden` and document count read at the end.

In plain Chrome on Windows, `chrome.ps1 -Hidden 6 -Svgs 30` opens the page in 7 tabs, 6 of them in the background, and samples Chrome's renderers the same way. The page then kicks its own GC through `?kick=3`.

The page builds about 17k nodes, 40k style rules and 70 MB of JS objects, and masks each of its 2,400 chips with one of the N SVG images (`data:` URIs). In the app it came from, serving the same SVGs by URL behaved the same.

## What happens

Read in the source of Chromium 156.0.8078.80 and V8 [`c9b3cfca`](https://github.com/v8/v8/tree/c9b3cfcab30ace06c21f9b48a0f0a34805e81e9d). Current `main` still has steps 1 and 2.

1. Each SVG image creates its own `AgentGroupScheduler` ([`svg_image.cc:100`](https://github.com/chromium/chromium/blob/156.0.8078.80/third_party/blink/renderer/core/svg/graphics/svg_image.cc#L100)).
2. After every main-thread task, `MainThreadSchedulerImpl::PerformMicrotaskCheckpoint()` copies all schedulers into a `HeapVector<Member<AgentGroupSchedulerImpl>, 10>`. Past 10 entries that allocates on the Oilpan heap, on every task ([`main_thread_scheduler_impl.cc:1268`](https://github.com/chromium/chromium/blob/156.0.8078.80/third_party/blink/renderer/platform/scheduler/main_thread/main_thread_scheduler_impl.cc#L1268)).
3. While Oilpan is marking or sweeping, it skips prompt frees and in-place resizes, so those backings become garbage ([`explicit-management.cc:21`](https://github.com/v8/v8/blob/c9b3cfcab30ace06c21f9b48a0f0a34805e81e9d/src/heap/cppgc-internal/explicit-management.cc#L21)).
4. While the concurrent sweep job is alive, the low-priority `IncrementalSweepTask` only runs finalizers, returns `kInProgress` and reposts itself with no delay ([`sweeper.cc:1517`](https://github.com/v8/v8/blob/c9b3cfcab30ace06c21f9b48a0f0a34805e81e9d/src/heap/cppgc-internal/sweeper.cc#L1517)). Traced in one hidden renderer: 360,209 of these tasks and 363,226 microtask checkpoints in 15 seconds.
5. A hidden renderer's isolate is `kBestEffort`, so V8 optimizes for memory and starts the next GC with little headroom ([`heap.cc:3628`](https://github.com/v8/v8/blob/c9b3cfcab30ace06c21f9b48a0f0a34805e81e9d/src/heap/heap.cc#L3628)). Traced: marking started on "global allocation limit" with 0.94 MB available, then spent 551 ms finishing the previous sweep.

6. On Windows 11, a hidden renderer also gets EcoQoS power throttling (`kUseEcoQoSForBackgroundProcess`, on by default, [`process_win.cc:321`](https://github.com/chromium/chromium/blob/156.0.8078.80/base/process/process_win.cc#L321)). With `--disable-features=UseEcoQoSForBackgroundProcess` the loop never started.

Inferred from that: the spin tasks' garbage fills the headroom and starts the next GC before sweeping ends. Under EcoQoS the sweep job seems to finish too slowly to escape that, while each spinning main thread holds a core. Suspending all but one spinning renderer let that one settle within 30 seconds.

`--js-flags=--single-threaded-gc` removes the concurrent sweep job, and with it the spin. In the app, `--heap-growing-percent=200`, `--no-memory-reducer`, `--no-single-threaded-gc-in-background` and `--no-incremental-marking-for-gc-in-background` didn't help.

A DevTools client that emulates focus makes hidden pages visible and hides the bug. This repro reads the tabs only at the end, through `webContents.debugger`.

## Results

Each run hides the tabs, kicks their GC 3 times, then samples for 10–15 minutes. "Spin" means a hidden tab at 15% or more over the last third.

| Machine | Hidden | SVGs | Extra | Hidden tabs' CPU, last third |
|:--|--:|--:|:--|:--|
| Windows 11 arm64, 4 cores (`windows-11-arm`) | 6 | 30 | – | **65–67% each** (2 runs) |
| | 4 | 30 | – | **99% each** |
| | 8 | 30 | – | **49–50% each** |
| | 6 | 10 | – | **66% each** |
| | 6 | 8 | – | 0%, after spinning briefly |
| | 6 | 5 | – | 0%, after spinning briefly |
| | 2 | 30 | – | 0% |
| | 6 | 30 | `--js-flags=--single-threaded-gc` | 0% |
| | 6 | 30 | `--disable-renderer-backgrounding` | 0% |
| | 6 / 4 | 30 | `--disable-features=UseEcoQoSForBackgroundProcess` | 0% |
| Windows 11 x64, 2 vCPUs (cloud PC, no GPU) | 3 | 30 | – | **64% each** |
| | 3 | 5 | – | 0% |
| Windows Server 2025 x64, 4 cores (`windows-latest`) | 8 | 30 | – | 0% |
| macOS 26, 3 M1 cores, virtual (`macos-26`) | 6, 9 | 30 | – | 0% |
| Linux, 4 cores (`ubuntu-latest`) | 8 | 30 | – | 0% |

8 SVGs make 9 documents per tab: the page plus 8 images, so 9 schedulers fit the vector's 10 slots. 10 SVGs make 11 and overflow it.

`--repro-churn=20`, which creates garbage every 20 seconds instead of kicking 3 times, made the cloud PC spin even with 5 SVGs. Each GC's sweep then spins on its own. The same churn on Windows Server, Linux and macOS stayed quiet. The repo's Actions history holds every run, including core pinning and CPU hogs.
