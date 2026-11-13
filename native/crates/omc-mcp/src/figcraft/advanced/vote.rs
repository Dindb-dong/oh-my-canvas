use super::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    time::{SystemTime, UNIX_EPOCH},
};

const KEY: &str = "boardVoting";
const HISTORY: usize = 20;

#[derive(Clone, Default, Deserialize, Serialize)]
struct Voting {
    current: Option<Vote>,
    history: Vec<Vote>,
}

#[derive(Clone, Deserialize, Serialize)]
struct Vote {
    id: String,
    per_person: usize,
    by: String,
    scope: Scope,
    ended: Option<u64>,
    ballots: BTreeMap<String, Vec<String>>,
}

#[derive(Clone, Deserialize, Serialize)]
enum Scope {
    All,
    Stickies,
    Selection(Vec<String>),
}

impl Scope {
    fn accepts(&self, snapshot: &DocumentSnapshot, id: &str) -> bool {
        snapshot.nodes.get(id).is_some_and(|node| {
            node.parent_id.is_some()
                && match self {
                    Self::All => true,
                    Self::Stickies => node.string(board::TYPE) == Some("sticky"),
                    Self::Selection(ids) => ids.iter().any(|candidate| candidate == id),
                }
        })
    }

    fn describe(&self, context: &Context) -> Value {
        match self {
            Self::All => json!("all"),
            Self::Stickies => json!("stickies"),
            Self::Selection(ids) => json!({
                "selection":ids.iter().map(|id| context.alias(id)).collect::<Vec<_>>()
            }),
        }
    }
}

impl Vote {
    fn counted<'a>(
        &self,
        snapshot: &'a DocumentSnapshot,
        ballot: &'a [String],
    ) -> impl Iterator<Item = &'a str> {
        ballot
            .iter()
            .filter(|id| snapshot.nodes.contains_key(*id))
            .take(self.per_person)
            .map(String::as_str)
    }

    fn rows(&self, context: &Context) -> Vec<Value> {
        let mut tally = BTreeMap::<&str, BTreeMap<&str, usize>>::new();
        for (voter, ballot) in &self.ballots {
            for id in self.counted(context.snapshot, ballot) {
                *tally.entry(id).or_default().entry(voter).or_default() += 1;
            }
        }
        let mut totals = tally
            .into_iter()
            .map(|(id, voters)| (id, voters.values().sum::<usize>(), voters))
            .collect::<Vec<_>>();
        totals.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));
        let mut rank = 0;
        let mut last_total = None;
        totals
            .into_iter()
            .enumerate()
            .map(|(index, (id, total, voters))| {
                if last_total != Some(total) {
                    rank = index + 1;
                    last_total = Some(total);
                }
                let votes = voters
                    .into_iter()
                    .map(|(voter, votes)| json!({"voter":voter,"name":voter,"votes":votes}))
                    .collect::<Vec<_>>();
                json!({"id":context.alias(id),"name":object_name(context.snapshot,id),"votes":total,"rank":rank,"voters":votes})
            })
            .collect()
    }
}

fn object_name(snapshot: &DocumentSnapshot, id: &str) -> String {
    let node = &snapshot.nodes[id];
    let label = node.string("name").unwrap_or_default();
    let text = if matches!(node.string(board::TYPE), Some("sticky" | "shape")) {
        children(snapshot, id)
            .into_iter()
            .find_map(|child| {
                child
                    .string("text")
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
            })
            .unwrap_or(label)
    } else {
        label
    };
    let first = text.lines().next().unwrap_or_default();
    let mut name = first.chars().take(60).collect::<String>();
    if name.len() < text.len() {
        name.push('…');
    }
    name
}

fn name(value: &str) -> String {
    value
        .trim()
        .chars()
        .filter(|c| !c.is_control())
        .take(64)
        .collect()
}

fn running(state: &mut Voting) -> Result<&mut Vote> {
    state
        .current
        .as_mut()
        .filter(|vote| vote.ended.is_none())
        .ok_or_else(|| EngineError::invalid("No vote is running"))
}

pub(super) fn command(context: &Context, action: &str) -> Result<Value> {
    let mut voting = context
        .snapshot
        .metadata
        .get(KEY)
        .filter(|state| !state.is_null())
        .map(|state| serde_json::from_value::<Voting>(state.clone()))
        .transpose()
        .map_err(|error| {
            EngineError::new(
                "corrupt_state",
                format!("Invalid board voting state: {error}"),
            )
        })?
        .unwrap_or_default();
    let mut changes = Properties::new();
    if let Some(vote) = voting.current.as_mut().filter(|vote| vote.ended.is_none()) {
        let prefix = ballot_prefix(&vote.id);
        for (key, value) in context.snapshot.metadata.range(prefix.clone()..) {
            if !key.starts_with(&prefix) {
                break;
            }
            if let (Some(voter), Some(ids)) = (value["voter"].as_str(), value["ids"].as_array()) {
                vote.ballots.insert(
                    voter.to_owned(),
                    ids.iter()
                        .take(vote.per_person)
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect(),
                );
            }
        }
    }
    let session_name = name(&context.router.workspace.session(context.session)?.author);
    let voter = context.params["voter"]
        .as_str()
        .map(name)
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| session_name.clone());
    if action == "vote" {
        let params = context.params;
        let action = string(params, "action")?;
        match action {
            "start" => {
                if voting
                    .current
                    .as_ref()
                    .is_some_and(|vote| vote.ended.is_none())
                {
                    return Err(EngineError::invalid("A vote is already running"));
                }
                let votes = params
                    .get("votes")
                    .filter(|v| !v.is_null())
                    .map(|value| {
                        value
                            .as_u64()
                            .filter(|votes| (1..=99).contains(votes))
                            .ok_or_else(|| {
                                EngineError::invalid("votes must be a whole number from 1 to 99")
                            })
                    })
                    .transpose()?
                    .unwrap_or(3);
                let scope = match params["on"].as_str().unwrap_or("all") {
                    "all" => Scope::All,
                    "stickies" => Scope::Stickies,
                    "selection" => {
                        let ids = context
                            .many()?
                            .into_iter()
                            .filter(|id| Scope::All.accepts(context.snapshot, id))
                            .collect::<Vec<_>>();
                        if ids.is_empty() {
                            return Err(EngineError::invalid("Choose the objects to vote on"));
                        }
                        Scope::Selection(ids)
                    }
                    _ => {
                        return Err(EngineError::invalid(
                            "on must be all, stickies or selection",
                        ));
                    }
                };
                voting.current = Some(Vote {
                    id: omc_model::new_id("vote"),
                    per_person: votes as usize,
                    by: session_name,
                    scope,
                    ended: None,
                    ballots: BTreeMap::new(),
                });
            }
            "cast" | "retract" => {
                let vote = running(&mut voting)?;
                let target = context.resolve(
                    params
                        .get("id")
                        .ok_or_else(|| EngineError::invalid("id required"))?,
                )?;
                let mut ballot = vote
                    .counted(
                        context.snapshot,
                        vote.ballots
                            .get(&voter)
                            .map(Vec::as_slice)
                            .unwrap_or_default(),
                    )
                    .map(str::to_owned)
                    .collect::<Vec<_>>();
                if action == "cast" {
                    if !vote.scope.accepts(context.snapshot, &target) {
                        return Err(EngineError::invalid("This vote is not on that object"));
                    }
                    if ballot.len() >= vote.per_person {
                        return Err(EngineError::invalid("No votes left"));
                    }
                    ballot.push(target);
                } else {
                    let index = ballot
                        .iter()
                        .rposition(|id| id == &target)
                        .ok_or_else(|| EngineError::invalid("No vote on that object"))?;
                    ballot.remove(index);
                }
                let key = format!(
                    "{}{}",
                    ballot_prefix(&vote.id),
                    hex::encode(Sha256::digest(voter.as_bytes()))
                );
                if ballot.is_empty() {
                    vote.ballots.remove(&voter);
                    changes.insert(key, Value::Null);
                } else {
                    changes.insert(key, json!({"voter":voter,"ids":ballot}));
                    vote.ballots.insert(voter.clone(), ballot);
                }
            }
            "end" => {
                let vote = running(&mut voting)?;
                let now = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default();
                vote.ended = Some(now.as_millis() as u64);
                let ended = vote.clone();
                voting.history.push(ended);
                let extra = voting.history.len().saturating_sub(HISTORY);
                voting.history.drain(..extra);
            }
            "clear" => voting.current = None,
            "delete" => {
                let index = index(params, "index")?;
                if index >= voting.history.len() {
                    return Err(EngineError::invalid("Vote session index is out of range"));
                }
                let removed = voting.history.remove(index);
                if voting
                    .current
                    .as_ref()
                    .is_some_and(|current| current.id == removed.id)
                {
                    voting.current = None;
                }
            }
            _ => return Err(EngineError::invalid("Unknown vote action")),
        }
        if changes.is_empty() {
            let value = if voting.current.is_none() && voting.history.is_empty() {
                Value::Null
            } else {
                serde_json::to_value(&voting)
                    .map_err(|error| EngineError::invalid(error.to_string()))?
            };
            if context.snapshot.metadata.get(KEY).unwrap_or(&Value::Null) != &value {
                changes.insert(KEY.into(), value);
            }
        }
        if !changes.is_empty() {
            context.commit(vec![Command::DocumentMetadata {
                properties: changes,
            }])?;
        }
    }
    Ok(describe(context, &voting, &voter))
}

fn ballot_prefix(vote: &str) -> String {
    format!("boardBallot/{vote}/")
}

fn describe(context: &Context, voting: &Voting, voter: &str) -> Value {
    let sessions = voting.history.iter().enumerate().rev().map(|(index, vote)| {
        let on_board = voting.current.as_ref().is_some_and(|current| current.id == vote.id);
        json!({"index":index,"onBoard":on_board,"ended":vote.ended,"votesPerPerson":vote.per_person,
            "on":vote.scope.describe(context),"by":vote.by,"results":vote.rows(context)})
    }).collect::<Vec<_>>();
    let Some(vote) = &voting.current else {
        return json!({"state":"off","sessions":sessions});
    };
    let mut mine = Vec::<(&str, usize)>::new();
    if let Some(ballot) = vote.ballots.get(voter) {
        for id in vote.counted(context.snapshot, ballot) {
            if let Some((_, count)) = mine.iter_mut().find(|(voted, _)| *voted == id) {
                *count += 1;
            } else {
                mine.push((id, 1));
            }
        }
    }
    let left = vote
        .per_person
        .saturating_sub(mine.iter().map(|(_, count)| count).sum());
    let mine = mine
        .into_iter()
        .map(|(id, votes)| json!({"id":context.alias(id),"votes":votes}))
        .collect::<Vec<_>>();
    let voters = vote
        .ballots
        .values()
        .filter(|ballot| vote.counted(context.snapshot, ballot).next().is_some())
        .count();
    let results = vote.ended.map(|_| {
        sessions
            .iter()
            .find(|session| session["onBoard"] == true)
            .map_or_else(
                || json!(vote.rows(context)),
                |session| session["results"].clone(),
            )
    });
    let mut out = json!({"state":if vote.ended.is_some() {"ended"} else {"running"},
        "votesPerPerson":vote.per_person,"on":vote.scope.describe(context),"by":vote.by,
        "left":left,"mine":mine,"voters":voters,"sessions":sessions});
    if let Some(results) = results {
        out["results"] = results;
    }
    out
}
