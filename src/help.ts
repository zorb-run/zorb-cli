export const TOP_LEVEL_HELP = `zorb — declarative local workflow runner

Usage:
  zorb <command> [options]

Commands:
  run <task>         Run a task from zorb.yml
  use <action>       Run an action directly, no zorb.yml needed
  list               List tasks defined in zorb.yml
  help [command]     Show help for a command

Global options:
  --file <path>      Use a different workflow file
  --env-file <path>  Load env vars from a file before running
  -v, --verbose      Verbose output
      --debug        Debug output
      --quiet        Suppress non-error output
      --no-color     Disable coloured output
      --version      Print version
  -h, --help         Print help

Run 'zorb help <command>' for details on a specific command.`;

const HELP_RUN = `zorb run — run a task from zorb.yml

Usage:
  zorb run <task> [options]

Options:
  --with <key=value>     Pass inputs to the task (repeatable)
  --watch <glob>         Re-run the task when files matching the glob change
  --file <path>          Use a different workflow file
  --env-file <path>      Load env vars from a file before running

Examples:
  zorb run build
  zorb run deploy --with environment=staging --with dry-run=true`;

const HELP_USE = `zorb use — run an action directly, no zorb.yml needed

Usage:
  zorb use <action> [options]

Options:
  --with <key=value>     Pass inputs to the action (repeatable)
  --file <path>          Use zorb.yml's env/defaults from a different file

Examples:
  zorb use ./check.action --with verbose=true
  zorb use @zorb/aws/s3/sync --with bucket=my-bucket`;

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
  --file <path>          Use a different workflow file

Prints each task with its description and any required inputs.`;

export const COMMAND_HELP: Record<string, string> = {
  run: HELP_RUN,
  use: HELP_USE,
  list: HELP_LIST,
  help: HELP_HELP,
};
