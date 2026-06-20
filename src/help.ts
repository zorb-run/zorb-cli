export const TOP_LEVEL_HELP = `zorb — declarative local workflow runner

Usage:
  zorb <command> [options]

Commands:
  init               Scaffold a starter zorb.yml in the current directory
  run <task>         Run a task from zorb.yml
  use <action>       Run an action directly, no zorb.yml needed
  list               List tasks defined in zorb.yml
  help [command]     Show help for a command

Global options:
  -f, --file <path>  Use a different workflow file
      --env-file <path>
                     Load env vars from a file before running
  -e, --env KEY=VALUE
                     Set an env var inline (repeatable, overrides --env-file)
  -v, --verbose      Verbose output
      --debug        Debug output
      --quiet        Suppress non-error output
      --no-color     Disable coloured output
      --version      Print version
  -h, --help         Print help

Run 'zorb help <command>' for details on a specific command.`;

const HELP_INIT = `zorb init — scaffold a starter zorb.yml in the current directory

Usage:
  zorb init

Errors if a zorb.yml already exists in the current directory. The scaffold
includes the editor-support schema header and a single example task you can
edit or replace.

Examples:
  zorb init`;

const HELP_RUN = `zorb run — run a task from zorb.yml

Usage:
  zorb run <task> [options]

Options:
      --with <key=value>     Pass inputs to the task (repeatable)
      --watch <glob>         Re-run the task when files matching the glob change
  -f, --file <path>          Use a different workflow file
      --env-file <path>      Load env vars from a file before running
  -e, --env KEY=VALUE        Set an env var inline (repeatable)

Examples:
  zorb run build
  zorb run deploy --with environment=staging --with dry-run=true
  zorb run test -e CI=true -e LOG_LEVEL=debug`;

const HELP_USE = `zorb use — run an action directly, no zorb.yml needed

Usage:
  zorb use <action> [options]

Options:
      --with <key=value>     Pass inputs to the action (repeatable)
  -f, --file <path>          Use zorb.yml's env/defaults from a different file
      --env-file <path>      Load env vars from a file before running
  -e, --env KEY=VALUE        Set an env var inline (repeatable)

Examples:
  zorb use ./check.action --with verbose=true
  zorb use @zorb/aws/s3/sync --with bucket=my-bucket -e AWS_REGION=eu-west-1`;

const HELP_HELP = `zorb help — show help for a command

Usage:
  zorb help [command]

Examples:
  zorb help
  zorb help run
  zorb help use`;

const HELP_LIST = `zorb list — list tasks defined in zorb.yml

Usage:
  zorb list [options]

Options:
  -f, --file <path>      Use a different workflow file
      --env-file <path>  Load env vars from a file before running
  -e, --env KEY=VALUE    Set an env var inline (repeatable)

Prints each task with its description and any required inputs.`;

export const COMMAND_HELP: Record<string, string> = {
  init: HELP_INIT,
  run: HELP_RUN,
  use: HELP_USE,
  list: HELP_LIST,
  help: HELP_HELP,
};
