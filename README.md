# check_availability

Checks booking availability on `q.wildlifesanctuaryfca16.com`. It has two modes:

- **Range check:** looks up every date in a range once (requests run in parallel) and prints a table and summary.
- **Watch:** keeps checking a single date at a set interval, and stops and notifies you as soon as a spot opens.

## Requirements

Use either:

- **Docker** (recommended), or
- **Node.js 18.3+** to run `check_availability.mjs` directly. There are no npm dependencies.

## Quick start

```sh
docker build -t check-availability .

# Check all of February once
docker run --rm check-availability --from 2027-02-01 --to 2027-02-28

# Keep checking Feb 7 every 5 minutes until a spot opens
docker run --rm -it check-availability --watch 2027-02-07 --interval 5m
```

Without Docker, replace `docker run --rm check-availability` with `node check_availability.mjs`.

## Range check

```sh
check_availability --from DATE [--to DATE]
check_availability START END          # positional form, same result
```

`--to` defaults to `--from`, so `--from 2027-02-07` checks a single date. Dates use the `yyyy-mm-dd` format.

Example output:

```
DATE         CAPACITY  AVAILABLE  STATUS
----------   --------  ---------  ------
2027-02-08        100          0  full
2027-02-09        100          0  full
2027-02-10        100        100  AVAILABLE

===== Summary =====
Dates with availability (1):
  - 2027-02-10 (100 left)
```

Dates whose request still fails after the retries show `ERROR` and are listed at the end of the summary.

## Watch mode

```sh
check_availability --watch DATE [--interval TIME] [--on-available CMD]
```

- **`--interval`:** time between checks, such as `30`, `30s`, `5m` or `1h`. The default is `60s` and the minimum is `5s`.
- **Status:** when it runs in a terminal (`docker run -it`), one status line updates in place:
  ```
  [10:42:04] check #2: full (0/100) | running 7s | next in 4s
  ```
  Without a terminal (logs, `docker run -d`), it prints one line per check.
- **When a spot opens:** it prints a banner, rings the terminal bell, runs `--on-available` if set, and exits with code `0`.
- **Failed checks** show `ERROR` in the status and don't stop the watch.
- **Ctrl+C** stops it and exits with code `130`.

### Notifications

On macOS, when the script runs directly with Node (not in Docker), it also shows a desktop notification.

From Docker, use `--on-available` to run any shell command when a spot opens. The command gets the variables `DATE`, `AVAILABLE` and `CAPACITY`. For example, to send a phone push through [ntfy.sh](https://ntfy.sh) (pick your own topic name):

```sh
docker run --rm -it check-availability --watch 2027-02-07 --interval 5m \
  --on-available 'wget -qO- --post-data "$DATE: $AVAILABLE spots open" https://ntfy.sh/my-topic'
```

To leave a watch running in the background:

```sh
docker run -d --name watch-feb7 check-availability --watch 2027-02-07 --interval 5m --on-available '...'
docker logs -f watch-feb7
```

## Options

| Option | Default | Env var | Description |
| --- | --- | --- | --- |
| `--from DATE` | | | First date of the range |
| `--to DATE` | same as `--from` | | Last date of the range |
| `--concurrency N` | `5` | `CONCURRENCY` | Max requests in flight at once (range check) |
| `--watch DATE` | | | Date to keep checking |
| `--interval TIME` | `60s` | | Time between checks (watch) |
| `--on-available CMD` | | | Shell command to run when a spot opens (watch) |
| `--retries N` | `2` | `RETRIES` | Extra attempts per failed request, with backoff |
| `--timeout-ms N` | `15000` | `TIMEOUT_MS` | Per-request timeout |
| `-h`, `--help` | | | Show help |

If you raise `--concurrency` a lot, the server may start rejecting requests.

## Files

- `check_availability.mjs`: the Node.js script (both modes).
- `Dockerfile`: runs the Node script on `node:22-alpine`.
