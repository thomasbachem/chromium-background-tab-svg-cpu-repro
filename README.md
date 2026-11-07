# SVG images keep hidden Chromium tabs busy

On a machine with fewer cores than hidden tabs, a page that uses more than about 10 distinct SVG images keeps every hidden tab's renderer main thread at 50–95% of a core for as long as the tabs stay hidden. Found in an Electron app (Electron 44.5.1 and 45.2.2, Chromium 156.0.8078.80, V8 15.6.75), reduced to this repro.

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
| `--repro-kick=<n>` | 3 | Rounds of DOM + JS garbage in each hidden tab right after hiding, 5s apart, so its GC starts |
| `--repro-churn=<s>` | off | The same garbage every N seconds for the whole run. This spins even with few SVGs on a small machine, as each GC's sweep then spins |
| `--repro-cores=<n>` | all | Pins the app to the first N cores (Windows and Linux) |
| `--repro-hogs=<n>` | 0 | Runs N busy processes beside it |
| `--repro-hog-seconds=<s>` | whole run | Stops the hogs after this long |

Every 10 seconds a line gives each tab's renderer CPU. The last line reads `repro: spin` or `repro: quiet`, judged on the last third of the samples. `results/` keeps the log and a JSON summary, including each tab's `document.hidden` and document count read at the end.

The page builds about 17k nodes, 40k style rules and 70 MB of JS objects, and masks each of its 2,400 chips with one of the N SVG images (`data:` URIs). In the app it came from, serving the same SVGs by URL behaved the same.

## What happens

Read in the source of Chromium 156.0.8078.80 and V8 [`c9b3cfca`](https://github.com/v8/v8/tree/c9b3cfcab30ace06c21f9b48a0f0a34805e81e9d). Current `main` still has steps 1 and 2.

1. Each SVG image creates its own `AgentGroupScheduler` ([`svg_image.cc:100`](https://github.com/chromium/chromium/blob/156.0.8078.80/third_party/blink/renderer/core/svg/graphics/svg_image.cc#L100)).
2. After every main-thread task, `MainThreadSchedulerImpl::PerformMicrotaskCheckpoint()` copies all schedulers into a `HeapVector<Member<AgentGroupSchedulerImpl>, 10>`. Past 10 entries that allocates on the Oilpan heap, on every task ([`main_thread_scheduler_impl.cc:1268`](https://github.com/chromium/chromium/blob/156.0.8078.80/third_party/blink/renderer/platform/scheduler/main_thread/main_thread_scheduler_impl.cc#L1268)).
3. While Oilpan is marking or sweeping, it skips prompt frees and in-place resizes, so those backings become garbage ([`explicit-management.cc:21`](https://github.com/v8/v8/blob/c9b3cfcab30ace06c21f9b48a0f0a34805e81e9d/src/heap/cppgc-internal/explicit-management.cc#L21)).
4. While the concurrent sweep job is alive, the low-priority `IncrementalSweepTask` only runs finalizers, returns `kInProgress` and reposts itself with no delay ([`sweeper.cc:1517`](https://github.com/v8/v8/blob/c9b3cfcab30ace06c21f9b48a0f0a34805e81e9d/src/heap/cppgc-internal/sweeper.cc#L1517)). Traced in one hidden renderer: 360,209 of these tasks and 363,226 microtask checkpoints in 15 seconds.
5. A hidden renderer's isolate is `kBestEffort`, so V8 optimizes for memory and starts the next GC with little headroom ([`heap.cc:3628`](https://github.com/v8/v8/blob/c9b3cfcab30ace06c21f9b48a0f0a34805e81e9d/src/heap/heap.cc#L3628)). Traced: marking started on "global allocation limit" with 0.94 MB available, then spent 551 ms finishing the previous sweep.

Inferred from that: the spin tasks' garbage fills the headroom and starts the next GC before sweeping ends. With few cores, each renderer's spinning main thread starves the other renderers' sweep jobs, which keeps the loop going. Suspending all but one spinning renderer let that one settle within 30 seconds.

`--js-flags=--single-threaded-gc` removes the concurrent sweep job, and with it the spin. In the app, `--heap-growing-percent=200`, `--no-memory-reducer`, `--no-single-threaded-gc-in-background` and `--no-incremental-marking-for-gc-in-background` didn't help.

A DevTools client that emulates focus makes hidden pages visible and hides the bug. This repro reads the tabs only at the end, through `webContents.debugger`.

## Results

| Machine | Hidden tabs | SVGs | Flags | Verdict | Hidden tabs' CPU, last third |
|:--|--:|--:|:--|:--|:--|
| Windows 11, 2 vCPUs, Xeon Platinum 8573C (cloud VM, no GPU) | 3 | 30 | – | spin | 64%, 65%, 65% |

The GitHub runs in this repo's Actions add macOS (3 M1 cores), Windows and Linux (4 cores each, pinned to 2 in some jobs).
