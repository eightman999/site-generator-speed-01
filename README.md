# site-generator-speed-01 — a faster makefun-site

[![make.fun site-generator-speed-01](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/eightman999/site-generator-speed-01/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/eightman999/site-generator-speed-01/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

An entry for [make.fun's site-generator-speed-01](https://make.fun/bounty/site-generator-speed-01-run-20261122):
a faster drop-in replacement for makefun-site 1.0.0, the reference static
site generator. For every case, the output tree is byte-identical to the
reference's — the speedup comes from compiling templates once instead of
interpreting them on every page.

Verified locally: all 3 practice cases identical to the expected output
(and to the baseline), `grade-local` passed 3 of 3, and the build step
itself runs about 2.2x faster than the reference on CPU time.
