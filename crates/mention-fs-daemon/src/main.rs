use std::{
    env,
    io::{self, BufRead, Write},
    path::PathBuf,
    process::ExitCode,
    thread,
};

use mention_fs_core::{Query, QueryId, spawn};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Command {
    Query {
        id: QueryId,
        pattern: String,
        #[serde(default)]
        hidden: bool,
        #[serde(default)]
        directories_only: bool,
        #[serde(default = "default_limit")]
        limit: usize,
    },
    Restart {
        #[serde(default)]
        hidden: bool,
    },
    Stop,
}

const fn default_limit() -> usize {
    100
}

fn run(root: PathBuf) -> Result<(), Box<dyn std::error::Error>> {
    let (controller, stream) = spawn(&root)?;
    let input_controller = controller.clone();

    let input = thread::Builder::new()
        .name("mention-fs-stdin".into())
        .spawn(move || {
            let stdin = io::stdin();
            for line in stdin.lock().lines() {
                let Ok(line) = line else {
                    break;
                };
                let command = match serde_json::from_str::<Command>(&line) {
                    Ok(command) => command,
                    Err(error) => {
                        eprintln!("invalid command: {error}");
                        continue;
                    }
                };
                match command {
                    Command::Query {
                        id,
                        pattern,
                        hidden,
                        directories_only,
                        limit,
                    } => {
                        if input_controller
                            .query(Query {
                                id,
                                pattern,
                                hidden,
                                directories_only,
                                limit,
                            })
                            .is_err()
                        {
                            break;
                        }
                    }
                    Command::Restart { hidden } => {
                        if input_controller.restart(hidden).is_err() {
                            break;
                        }
                    }
                    Command::Stop => break,
                }
            }
            input_controller.stop();
        })?;

    let stdout = io::stdout();
    let mut output = stdout.lock();
    for event in stream {
        serde_json::to_writer(&mut output, &event)?;
        output.write_all(b"\n")?;
        output.flush()?;
    }
    let _ = input.join();
    Ok(())
}

fn main() -> ExitCode {
    let Some(root) = env::args_os().nth(1) else {
        eprintln!("usage: mention-fs <root>");
        return ExitCode::from(2);
    };
    match run(PathBuf::from(root)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("mention-fs: {error}");
            ExitCode::FAILURE
        }
    }
}
