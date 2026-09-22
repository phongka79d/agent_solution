#!/usr/bin/env node
/**
 * Docker Compose smoke for the three named application images
 * (`implement/09` §10: build, load into the local daemon, inspect — never push).
 *
 * The script drives the repository's own `docker-compose.yml`, so what it
 * verifies is the shipped topology rather than a hand-written `docker build`
 * line: it builds `api`, `worker` and `command-center` through Compose, proves
 * each image is present in the local daemon, boots the default profile, and
 * waits until all three application services report healthy.
 *
 * Fail-closed rules:
 *   - missing `docker`, Compose v2, a reachable daemon, the compose file, the
 *     three Dockerfiles, or the environment file aborts before anything runs;
 *   - an image that Compose did not load locally aborts instead of being
 *     inspected as a stand-in;
 *   - a container that exits, or one that never becomes healthy inside the
 *     deadline, aborts with its compose status and log tail;
 *   - every Compose command is scoped to this script's own project name, and
 *     the project is torn down (containers, network, volumes) even on failure.
 *
 * Nothing here pushes, publishes, or tags a remote image: the images stay in the
 * local daemon, and the environment file is handed to Compose but never read or
 * printed by this script.
 *
 * Usage: node scripts/docker-smoke.mjs [--env-file <path>] [--project <name>] [--wait-seconds <n>]
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Services whose images this smoke builds, loads, and inspects. */
const SERVICES = ['api', 'worker', 'command-center'];

/** Compose project owned by this script; never the developer's default project. */
const DEFAULT_PROJECT = 'agentos-ci-smoke';

const COMPOSE_FILE = 'docker-compose.yml';
const DEFAULT_ENV_FILE = '.env';
const DEFAULT_WAIT_SECONDS = 300;
const POLL_INTERVAL_MS = 5_000;

/** Per-command deadlines in seconds; the image build is the only long one. */
const COMMAND_TIMEOUTS = {
  default: 120,
  build: 1_800,
  up: 900,
  down: 300,
};

/**
 * Prints one progress line.
 *
 * @param message - Line to print.
 */
function log(message) {
  console.log(`[docker-smoke] ${message}`);
}

/**
 * Prints an error and exits non-zero. Used for prerequisites that must never be
 * guessed around.
 *
 * @param message - Failure description, prefixed with an UPPER_SNAKE code.
 */
function fail(message) {
  console.error(message);
  process.exit(1);
}

/**
 * Parses `--flag value` / `--flag=value` arguments.
 *
 * @param argv - `process.argv.slice(2)`.
 * @returns Resolved options.
 */
function parseArgs(argv) {
  const options = {
    envFile: undefined,
    project: DEFAULT_PROJECT,
    waitSeconds: DEFAULT_WAIT_SECONDS,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }

    const [name, inlineValue] = argument.startsWith('--') && argument.includes('=')
      ? [argument.slice(0, argument.indexOf('=')), argument.slice(argument.indexOf('=') + 1)]
      : [argument, undefined];

    if (name === '--env-file' || name === '--project' || name === '--wait-seconds') {
      const value = inlineValue ?? argv[index + 1];

      if (value === undefined || value.startsWith('--')) {
        fail(`ARGUMENT_VALUE_REQUIRED: ${name} needs a value.`);
      }

      if (inlineValue === undefined) {
        index += 1;
      }

      if (name === '--env-file') {
        options.envFile = value;
      } else if (name === '--project') {
        options.project = value;
      } else {
        const seconds = Number.parseInt(value, 10);

        if (!Number.isInteger(seconds) || seconds <= 0) {
          fail(`INVALID_WAIT_SECONDS: expected a positive integer, received "${value}".`);
        }

        options.waitSeconds = seconds;
      }

      continue;
    }

    fail(`UNKNOWN_ARGUMENT: "${argument}". Supported: --env-file <path>, --project <name>, --wait-seconds <n>.`);
  }

  return options;
}

/**
 * Runs one command with a deadline and captured output.
 *
 * @param command - Executable to run.
 * @param args - Argument vector.
 * @param timeoutSeconds - Deadline; the child is killed when it elapses.
 * @returns `{ ok, status, stdout, stderr, error }`.
 */
function run(command, args, timeoutSeconds = COMMAND_TIMEOUTS.default) {
  log(`$ ${command} ${args.join(' ')}`);

  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutSeconds * 1_000,
  });

  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
  };
}

/**
 * Describes a failed command for the operator: exit status or spawn error, then
 * the captured stderr.
 *
 * @param label - Command label used in the message.
 * @param result - Result from {@link run}.
 * @returns Single-line-plus-stderr description.
 */
function describeFailure(label, result) {
  const reason = result.error?.code === 'ETIMEDOUT'
    ? 'timed out'
    : `exited ${result.status ?? `with ${result.error?.code ?? 'an unknown error'}`}`;

  return `${label} ${reason}.${result.stderr.trim() ? `\n${result.stderr.trim()}` : ''}`;
}

/**
 * Reads the containers of a Compose project in every `ps --format json` shape
 * Compose v2 emits (JSON array in recent versions, one JSON object per line in
 * older ones).
 *
 * @param stdout - Raw `docker compose ps --format json` stdout.
 * @returns Parsed container records.
 */
function parseComposePs(stdout) {
  const trimmed = stdout.trim();

  if (trimmed.length === 0) {
    return [];
  }

  if (trimmed.startsWith('[')) {
    return JSON.parse(trimmed);
  }

  return trimmed
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

const isHealthy = (container) =>
  container.State === 'running' && (typeof container.Health !== 'string' || container.Health === '' || container.Health === 'healthy');

const hasFailed = (container) => container.State === 'exited' || container.State === 'dead';

/**
 * Awaits the healthy state of the three application services, failing fast on a
 * container that has exited.
 *
 * @param listContainers - Callback returning current project containers.
 * @param deadline - Epoch milliseconds after which the wait fails.
 * @returns The healthy container records, keyed by service.
 */
async function waitForServicesHealthy(listContainers, deadline) {
  const observed = new Map();

  for (;;) {
    const containers = listContainers();
    observed.clear();

    for (const container of containers) {
      observed.set(container.Service, container);
    }

    const crashed = SERVICES.map((service) => observed.get(service)).find((container) => container && hasFailed(container));

    if (crashed !== undefined) {
      throw new Error(`SERVICE_EXITED: ${crashed.Service} is ${crashed.State} (exit code ${crashed.ExitCode ?? 'unknown'}).`);
    }

    const pending = SERVICES.filter((service) => {
      const container = observed.get(service);

      return container === undefined || !isHealthy(container);
    });

    if (pending.length === 0) {
      return observed;
    }

    if (Date.now() >= deadline) {
      throw new Error(`SMOKE_TIMEOUT: ${pending.join(', ')} did not become healthy within the deadline.`);
    }

    log(`waiting for ${pending.join(', ')} (state: ${pending.map((service) => `${service}=${observed.get(service)?.State ?? 'absent'}`).join(', ')})`);

    await new Promise((resolvePromise) => {
      setTimeout(resolvePromise, POLL_INTERVAL_MS);
    });
  }
}

const options = parseArgs(process.argv.slice(2));

if (options.help) {
  console.log(
    'Usage: node scripts/docker-smoke.mjs [--env-file <path>] [--project <name>] [--wait-seconds <n>]\n' +
      `Builds, loads, and inspects the ${SERVICES.join('/')} images with Docker Compose, boots the stack, and\n` +
      'tears its own Compose project down. Nothing is pushed or published.',
  );
  process.exit(0);
}

if (!/^[a-z0-9][a-z0-9_-]*$/.test(options.project)) {
  fail(`INVALID_PROJECT_NAME: "${options.project}" is not a valid Compose project name.`);
}

const composeFile = resolve(repoRoot, COMPOSE_FILE);
const envFile = resolve(repoRoot, options.envFile ?? DEFAULT_ENV_FILE);

// ---------------------------------------------------------------------------
// 1. Prerequisites. Every missing one aborts; nothing is inferred or defaulted.
// ---------------------------------------------------------------------------

if (!existsSync(composeFile)) {
  fail(`COMPOSE_FILE_MISSING: ${COMPOSE_FILE} was not found at the repository root.`);
}

const missingDockerfiles = SERVICES.map((service) => `docker/Dockerfile.${service}`).filter(
  (dockerfile) => !existsSync(resolve(repoRoot, dockerfile)),
);

if (missingDockerfiles.length > 0) {
  fail(`DOCKERFILE_MISSING: ${missingDockerfiles.join(', ')} not found; this smoke only inspects images built from them.`);
}

if (!existsSync(envFile)) {
  fail(
    `ENV_FILE_MISSING: ${options.envFile ?? DEFAULT_ENV_FILE} was not found. docker-compose.yml requires secrets to be ` +
      'set (`${VAR:?}`), so pass a file explicitly, e.g. `--env-file .env.example` for a placeholder local/CI boot.',
  );
}

const dockerVersion = run('docker', ['--version']);

if (!dockerVersion.ok) {
  fail(`DOCKER_REQUIRED: ${describeFailure('`docker --version`', dockerVersion)}`);
}

const composeVersion = run('docker', ['compose', 'version']);

if (!composeVersion.ok) {
  fail(`DOCKER_COMPOSE_REQUIRED: ${describeFailure('`docker compose version`', composeVersion)} Install the Compose v2 plugin.`);
}

const daemon = run('docker', ['info', '--format', '{{.ServerVersion}}']);

if (!daemon.ok) {
  fail(`DOCKER_DAEMON_UNREACHABLE: ${describeFailure('`docker info`', daemon)}`);
}

const compose = (...args) => [
  'compose',
  '--file',
  composeFile,
  '--project-name',
  options.project,
  '--env-file',
  envFile,
  ...args,
];

const staleContainers = run('docker', [
  'ps',
  '--all',
  '--quiet',
  '--filter',
  `label=com.docker.compose.project=${options.project}`,
]);

if (staleContainers.ok && staleContainers.stdout.trim().length > 0) {
  fail(
    `STALE_PROJECT_CONTAINERS: project "${options.project}" already has containers. Run ` +
      `\`docker compose --file ${COMPOSE_FILE} --project-name ${options.project} --env-file ${options.envFile ?? DEFAULT_ENV_FILE} down --volumes --remove-orphans\` first.`,
  );
}

// ---------------------------------------------------------------------------
// 2. Build the three images through Compose (load into the local daemon).
// ---------------------------------------------------------------------------

const build = run('docker', compose('build', ...SERVICES), COMMAND_TIMEOUTS.build);

if (!build.ok) {
  fail(`IMAGE_BUILD_FAILED: ${describeFailure(`\`docker compose build ${SERVICES.join(' ')}\``, build)}`);
}

// ---------------------------------------------------------------------------
// 3. Prove each image is locally present, then inspect it.
// ---------------------------------------------------------------------------

const resolvedConfig = run('docker', compose('config', '--format', 'json'));

let imageRefs = SERVICES.map((service) => `${options.project}-${service}`);

if (resolvedConfig.ok) {
  try {
    const config = JSON.parse(resolvedConfig.stdout);
    imageRefs = SERVICES.map((service) => config.services?.[service]?.image ?? `${options.project}-${service}`);
  } catch {
    log('note: could not parse `docker compose config --format json`; falling back to Compose default image names.');
  }
} else {
  log('note: `docker compose config --format json` is unavailable on this Compose version; using default image names.');
}

const inspect = run('docker', ['image', 'inspect', ...imageRefs]);

if (!inspect.ok) {
  fail(
    `IMAGE_NOT_LOADED: ${describeFailure(`\`docker image inspect ${imageRefs.join(' ')}\``, inspect)} ` +
      'The smoke inspects only images loaded into the local daemon by this build.',
  );
}

const inspectedImages = JSON.parse(inspect.stdout);

if (!Array.isArray(inspectedImages) || inspectedImages.length !== imageRefs.length) {
  fail(`IMAGE_INSPECT_INCOMPLETE: expected ${imageRefs.length} images, received ${inspectedImages.length ?? 'none'}.`);
}

const imageIdsByService = new Map();

SERVICES.forEach((service, index) => {
  const image = inspectedImages[index];
  const repository = image.RepoTags?.[0] ?? '<untagged>';
  const labels = image.Config?.Labels ?? {};

  imageIdsByService.set(service, image.Id);

  log(
    `image ${service}: ${repository} | id ${String(image.Id).slice(0, 19)} | ${(image.Size / (1024 * 1024)).toFixed(1)} MiB | ` +
      `created ${image.Created} | compose labels ${labels['com.docker.compose.project'] ?? 'absent'}/` +
      `${labels['com.docker.compose.service'] ?? 'absent'} | no registry push performed`,
  );
});

// ---------------------------------------------------------------------------
// 4. Boot the default profile and wait for the three services to be healthy.
// ---------------------------------------------------------------------------

const up = run('docker', compose('up', '--detach'), COMMAND_TIMEOUTS.up);

if (!up.ok) {
  fail(`SERVICE_START_FAILED: ${describeFailure('`docker compose up --detach`', up)}`);
}

const listContainers = () => {
  const listed = run('docker', compose('ps', '--all', '--format', 'json'));

  if (!listed.ok) {
    throw new Error(describeFailure('`docker compose ps --format json`', listed));
  }

  return parseComposePs(listed.stdout);
};

const deadline = Date.now() + options.waitSeconds * 1_000;

try {
  const healthy = await waitForServicesHealthy(listContainers, deadline);

  for (const service of SERVICES) {
    const container = healthy.get(service);
    const imageId = imageIdsByService.get(service);
    const runningImage = container.Image ?? '';

    if (runningImage && runningImage !== imageId && !imageRefs.some((ref) => runningImage === ref || runningImage.startsWith(`${ref}:`))) {
      throw new Error(`IMAGE_MISMATCH: ${service} runs ${runningImage}, not the image this smoke built.`);
    }

    log(`service ${service}: ${container.Name ?? service} running | image ${runningImage || imageId.slice(0, 19)} | health ${container.Health || 'n/a'}`);
  }
} catch (error) {
  // Diagnostics must never mask the original failure: a `compose ps` that fails
  // here would otherwise replace this error and skip the teardown below.
  let status = [];

  try {
    status = listContainers();
  } catch (listingError) {
    console.error(`compose status unavailable: ${listingError.message}`);
  }

  const logTail = run('docker', compose('logs', '--tail', '40', ...SERVICES), COMMAND_TIMEOUTS.default);

  console.error(`SMOKE_FAILED: ${error.message}`);
  console.error(`compose status: ${status.map((container) => `${container.Service}=${container.State}/${container.Health ?? 'n/a'}`).join(', ')}`);
  console.error(logTail.stdout.trim());
  console.error(logTail.stderr.trim());

  cleanup(true);

  // A failed health wait, an exited service, or an image mismatch must fail the
  // run: falling through to the success log below would report green for a stack
  // that never came up.
  process.exit(1);
}

/**
 * Tears down this script's own Compose project: containers, network, and the
 * named volumes it created.
 *
 * @param failed - When true the script is already failing; cleanup problems are
 * reported but do not replace the original failure.
 */
function cleanup(failed) {
  const down = run('docker', compose('down', '--volumes', '--remove-orphans'), COMMAND_TIMEOUTS.down);

  if (down.ok) {
    log(`compose project ${options.project} torn down`);
    return;
  }

  const message = `COMPOSE_CLEANUP_FAILED: ${describeFailure('`docker compose down --volumes --remove-orphans`', down)}`;

  if (failed) {
    console.error(message);
    return;
  }

  fail(message);
}

cleanup(false);

log(
  `smoke passed: ${SERVICES.join('/')} built through Compose, loaded locally, inspected, and healthy on project ` +
    `${options.project}. No image was pushed or published, and no business behaviour was exercised.`,
);
