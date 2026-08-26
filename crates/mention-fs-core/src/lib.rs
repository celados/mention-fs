mod matcher;

use std::{
    io,
    path::Path,
    sync::mpsc::{self, Receiver, RecvError, RecvTimeoutError, SendError, Sender},
    thread::{self, JoinHandle},
    time::Duration,
};

use matcher::{FuzzyFileMatcher, FuzzyMatcherStatus};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct QueryId(pub u64);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Query {
    pub id: QueryId,
    pub pattern: String,
    pub hidden: bool,
    pub directories_only: bool,
    pub limit: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Match {
    pub path: String,
    pub score: u32,
    pub indices: Vec<u32>,
    pub is_directory: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Snapshot {
    pub query_id: QueryId,
    pub matches: Vec<Match>,
    pub total_items: usize,
    pub done: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event {
    Snapshot(Snapshot),
    Superseded { query_id: QueryId },
    Closed { query_id: Option<QueryId> },
}

#[derive(Debug)]
enum Command {
    Query(Query),
    Restart { hidden: bool },
    Stop,
}

#[derive(Clone)]
pub struct SearchController {
    commands: Sender<Command>,
}

impl SearchController {
    pub fn query(&self, query: Query) -> Result<(), SendError<Query>> {
        self.commands
            .send(Command::Query(query))
            .map_err(|error| match error.0 {
                Command::Query(query) => SendError(query),
                Command::Restart { .. } | Command::Stop => {
                    unreachable!("query send must return its query")
                }
            })
    }

    pub fn restart(&self, hidden: bool) -> Result<(), SendError<bool>> {
        self.commands
            .send(Command::Restart { hidden })
            .map_err(|error| match error.0 {
                Command::Restart { hidden } => SendError(hidden),
                Command::Query(_) | Command::Stop => {
                    unreachable!("restart send must return its hidden mode")
                }
            })
    }

    pub fn stop(&self) {
        let _ = self.commands.send(Command::Stop);
    }
}

pub struct EventStream {
    events: Receiver<Event>,
    commands: Sender<Command>,
    handle: Option<JoinHandle<()>>,
}

impl EventStream {
    pub fn recv(&self) -> Result<Event, RecvError> {
        self.events.recv()
    }

    pub fn recv_timeout(&self, timeout: Duration) -> Result<Event, RecvTimeoutError> {
        self.events.recv_timeout(timeout)
    }
}

impl Iterator for EventStream {
    type Item = Event;

    fn next(&mut self) -> Option<Self::Item> {
        self.events.recv().ok()
    }
}

impl Drop for EventStream {
    fn drop(&mut self) {
        let _ = self.commands.send(Command::Stop);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

pub fn spawn(root: &Path) -> io::Result<(SearchController, EventStream)> {
    let mut matcher = FuzzyFileMatcher::new(root);
    let (command_tx, command_rx) = mpsc::channel();
    let (event_tx, event_rx) = mpsc::channel();
    let stream_commands = command_tx.clone();

    let handle = thread::Builder::new()
        .name("mention-fs-source".into())
        .spawn(move || {
            let mut active: Option<Query> = None;
            let mut active_done = true;
            let mut indexed_hidden: Option<bool> = None;
            let mut last_matches = Vec::new();
            let mut last_done = false;

            loop {
                let command = if active.is_some() && !active_done {
                    command_rx.recv_timeout(Duration::from_micros(250))
                } else {
                    command_rx
                        .recv()
                        .map_err(|_| RecvTimeoutError::Disconnected)
                };

                match command {
                    Ok(Command::Restart { hidden }) => {
                        if let Some(previous) = active.as_ref()
                            && !active_done
                        {
                            let _ = event_tx.send(Event::Superseded {
                                query_id: previous.id,
                            });
                        }
                        if hidden {
                            matcher.restart_walk_with(|walker| {
                                walker.hidden(false).ignore(false).git_ignore(false)
                            });
                        } else {
                            matcher.restart_walk();
                        }
                        indexed_hidden = Some(hidden);
                        active = None;
                        active_done = true;
                        last_matches.clear();
                        last_done = false;
                    }
                    Ok(Command::Query(query)) => {
                        if let Some(previous) = active.as_ref()
                            && !active_done
                            && previous.id != query.id
                        {
                            let _ = event_tx.send(Event::Superseded {
                                query_id: previous.id,
                            });
                        }

                        if indexed_hidden != Some(query.hidden) {
                            if query.hidden {
                                matcher.restart_walk_with(|walker| {
                                    walker.hidden(false).ignore(false).git_ignore(false)
                                });
                            } else {
                                matcher.restart_walk();
                            }
                            indexed_hidden = Some(query.hidden);
                        }

                        matcher.set_query(&query.pattern, query.directories_only);
                        active = Some(query);
                        active_done = false;
                        last_matches.clear();
                        last_done = false;
                    }
                    Ok(Command::Stop) | Err(RecvTimeoutError::Disconnected) => {
                        let _ = event_tx.send(Event::Closed {
                            query_id: active.as_ref().map(|query| query.id),
                        });
                        break;
                    }
                    Err(RecvTimeoutError::Timeout) => {
                        let Some(query) = active.as_ref() else {
                            continue;
                        };
                        let FuzzyMatcherStatus { done, .. } = matcher.tick(10);
                        let matches = matcher
                            .get_top_k(query.limit)
                            .into_iter()
                            .map(|entry| Match {
                                path: entry.path.to_string(),
                                score: entry.score,
                                indices: entry.indices,
                                is_directory: entry.is_dir,
                            })
                            .collect::<Vec<_>>();

                        if matches != last_matches || done != last_done {
                            last_matches.clone_from(&matches);
                            last_done = done;
                            let _ = event_tx.send(Event::Snapshot(Snapshot {
                                query_id: query.id,
                                matches,
                                total_items: matcher.num_items(),
                                done,
                            }));
                        }
                        active_done = done;
                    }
                }
            }
        })?;

    Ok((
        SearchController {
            commands: command_tx,
        },
        EventStream {
            events: event_rx,
            commands: stream_commands,
            handle: Some(handle),
        },
    ))
}

#[cfg(test)]
mod tests {
    use std::{fs, time::Duration};

    use super::{Event, Query, QueryId, spawn};

    #[test]
    fn streams_matches_before_or_at_completion() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("src")).unwrap();
        fs::write(root.path().join("src/main.rs"), "fn main() {}\n").unwrap();
        fs::write(root.path().join("package.json"), "{}\n").unwrap();

        let (controller, stream) = spawn(root.path()).unwrap();
        controller
            .query(Query {
                id: QueryId(1),
                pattern: "pack".into(),
                hidden: false,
                directories_only: false,
                limit: 100,
            })
            .unwrap();

        loop {
            match stream.recv_timeout(Duration::from_secs(5)).unwrap() {
                Event::Snapshot(snapshot) if snapshot.query_id == QueryId(1) => {
                    assert_eq!(snapshot.matches[0].path, "package.json");
                    if snapshot.done {
                        break;
                    }
                }
                _ => {}
            }
        }
    }

    #[test]
    fn supersedes_an_inflight_query() {
        let root = tempfile::tempdir().unwrap();
        for index in 0..500 {
            fs::write(root.path().join(format!("file-{index}.txt")), "x").unwrap();
        }

        let (controller, stream) = spawn(root.path()).unwrap();
        controller
            .query(Query {
                id: QueryId(1),
                pattern: "file".into(),
                hidden: false,
                directories_only: false,
                limit: 10,
            })
            .unwrap();
        controller
            .query(Query {
                id: QueryId(2),
                pattern: "file-499".into(),
                hidden: false,
                directories_only: false,
                limit: 10,
            })
            .unwrap();

        let mut saw_second = false;
        for _ in 0..20 {
            if let Event::Snapshot(snapshot) = stream.recv_timeout(Duration::from_secs(5)).unwrap()
                && snapshot.query_id == QueryId(2)
            {
                saw_second = snapshot.matches.iter().any(|entry| entry.path == "file-499.txt");
                if snapshot.done {
                    break;
                }
            }
        }
        assert!(saw_second);
    }

    #[test]
    fn restart_reindexes_files_without_changing_hidden_mode() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("alpha.txt"), "a").unwrap();
        let (controller, stream) = spawn(root.path()).unwrap();
        controller
            .query(Query {
                id: QueryId(1),
                pattern: "txt".into(),
                hidden: false,
                directories_only: false,
                limit: 10,
            })
            .unwrap();
        loop {
            if let Event::Snapshot(snapshot) =
                stream.recv_timeout(Duration::from_secs(5)).unwrap()
                && snapshot.query_id == QueryId(1)
                && snapshot.done
            {
                assert!(snapshot.matches.iter().any(|entry| entry.path == "alpha.txt"));
                break;
            }
        }

        fs::remove_file(root.path().join("alpha.txt")).unwrap();
        fs::write(root.path().join("beta.txt"), "b").unwrap();
        controller.restart(false).unwrap();
        controller
            .query(Query {
                id: QueryId(2),
                pattern: "txt".into(),
                hidden: false,
                directories_only: false,
                limit: 10,
            })
            .unwrap();
        loop {
            if let Event::Snapshot(snapshot) =
                stream.recv_timeout(Duration::from_secs(5)).unwrap()
                && snapshot.query_id == QueryId(2)
                && snapshot.done
            {
                assert!(snapshot.matches.iter().any(|entry| entry.path == "beta.txt"));
                assert!(!snapshot.matches.iter().any(|entry| entry.path == "alpha.txt"));
                break;
            }
        }
    }
}
