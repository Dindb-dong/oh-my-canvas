use super::*;

struct Template {
    id: &'static str,
    name: &'static str,
    description: &'static str,
    size: (f64, f64),
    make: fn(&mut Builder<'_>) -> Result<()>,
}

// Preserves the upstream board template names, dimensions and starter content.
const TEMPLATES: &[Template] = &[
    Template {
        id: "retrospective",
        name: "Retrospective",
        description: "Three sections to look back on a stretch of work: what went well, what to improve, what to do next",
        size: (1280., 592.),
        make: retrospective,
    },
    Template {
        id: "brainstorm",
        name: "Brainstorm",
        description: "A question in the middle and four clusters of ideas around it",
        size: (1344., 760.),
        make: brainstorm,
    },
    Template {
        id: "weeklyPlanner",
        name: "Weekly planner",
        description: "A column for each working day with a note to start from",
        size: (1380., 632.),
        make: weekly,
    },
    Template {
        id: "flowChart",
        name: "Flow chart",
        description: "Steps, a decision and its two outcomes joined by connectors",
        size: (1220., 360.),
        make: flow,
    },
    Template {
        id: "kanban",
        name: "Kanban board",
        description: "To do, Doing and Done columns with cards to move along",
        size: (900., 812.),
        make: kanban,
    },
];

pub(super) fn command(context: &Context, action: &str) -> Result<Value> {
    if action == "templates" {
        return Ok(Value::Array(
            TEMPLATES
                .iter()
                .map(|template| {
                    json!({
                        "id":template.id,"name":template.name,"description":template.description,
                        "width":template.size.0,"height":template.size.1,
                    })
                })
                .collect(),
        ));
    }
    let name = string(context.params, "name")?;
    let template = TEMPLATES
        .iter()
        .find(|t| t.id == name)
        .ok_or_else(|| EngineError::invalid("name must be an id from board.templates"))?;
    let mut builder = Builder {
        context,
        snapshot: context.snapshot.clone(),
        at: (
            number(context.params, "x", (1440. - template.size.0) / 2.)?,
            number(context.params, "y", (900. - template.size.1) / 2.)?,
        ),
        edits: Vec::new(),
        ids: Vec::new(),
    };
    (template.make)(&mut builder)?;
    context.commit(builder.edits)?;
    let ids = builder
        .ids
        .iter()
        .map(|id| json!(context.alias(id)))
        .collect::<Vec<_>>();
    context
        .router
        .fig_selection(&(context.session.into(), context.snapshot.id.clone()), &ids);
    Ok(json!({"name":template.id,"ids":ids}))
}

struct Builder<'a> {
    context: &'a Context<'a>,
    snapshot: DocumentSnapshot,
    at: (f64, f64),
    edits: Vec<Command>,
    ids: Vec<String>,
}

impl Builder<'_> {
    fn add(&mut self, node: Node, top: bool) -> String {
        let id = node.id.clone();
        if top {
            self.ids.push(id.clone());
        }
        self.snapshot.nodes.insert(id.clone(), node.clone());
        self.edits.push(Command::NodeCreate { node });
        id
    }
    fn title(&mut self, text: &str) -> Result<()> {
        let root = &self.context.state.root;
        let node = new_layer(
            NodeKind::Text,
            &self.snapshot.nodes[root],
            append_rank(&self.snapshot, root)?,
            json!({
                "name":text,"text":text,"x":self.at.0,"y":self.at.1,"width":530.,"height":52.,
                "fill":"#1e1e1e","fontSize":32.,"style":{"position":"absolute"},
            }),
        )?;
        self.add(node, true);
        Ok(())
    }
    fn section(
        &mut self,
        name: &str,
        (x, y, w, h): (f64, f64, f64, f64),
        fill: &str,
    ) -> Result<String> {
        let root = &self.context.state.root;
        let node = new_layer(
            NodeKind::Frame,
            &self.snapshot.nodes[root],
            append_rank(&self.snapshot, root)?,
            json!({
                "name":name,"x":self.at.0+x,"y":self.at.1+y,"width":w,"height":h,"fill":fill,
                "isSection":true,"radius":12.,"style":{"position":"absolute"},
            }),
        )?;
        Ok(self.add(node, true))
    }
    fn note(
        &mut self,
        parent: Option<&str>,
        mut params: Value,
        at: (f64, f64),
        kind: &str,
    ) -> Result<String> {
        let top = parent.is_none();
        let parent = parent.unwrap_or(&self.context.state.root);
        params["parent"] = json!(self.context.alias(parent));
        params["x"] = json!(at.0 + if top { self.at.0 } else { 0. });
        params["y"] = json!(at.1 + if top { self.at.1 } else { 0. });
        let context = Context {
            snapshot: &self.snapshot,
            params: &params,
            ..*self.context
        };
        let (node, _, commands) = build_note(&context, kind)?;
        for command in commands {
            if let Command::NodeCreate { node: created } = command {
                let top = top && created.id == node.id;
                self.add(created, top);
            }
        }
        Ok(node.id)
    }
    fn sticky(
        &mut self,
        parent: Option<&str>,
        at: (f64, f64),
        text: &str,
        color: &str,
    ) -> Result<String> {
        self.note(
            parent,
            json!({"text":text,"color":color,"author":false}),
            at,
            "sticky",
        )
    }
    fn shape(
        &mut self,
        shape: &str,
        (x, y, w, h): (f64, f64, f64, f64),
        text: &str,
        color: &str,
    ) -> Result<String> {
        self.note(
            None,
            json!({"shape":shape,"width":w,"height":h,"text":text,"color":color,"author":false}),
            (x, y),
            "shape",
        )
    }
    fn join(&mut self, from: &str, to: &str, options: Value, label: Option<&str>) -> Result<()> {
        let root = &self.context.state.root;
        let center = |id: &str| {
            let node = &self.snapshot.nodes[id];
            [
                node.number("x", 0.) + node.number("width", 0.) / 2.,
                node.number("y", 0.) + node.number("height", 0.) / 2.,
            ]
        };
        let mut connector = json!({
            "from":{"layer":from,"side":options["fromSide"].as_str().unwrap_or("auto"),"fallback":center(from)},
            "to":{"layer":to,"side":options["toSide"].as_str().unwrap_or("auto"),"fallback":center(to)},
            "style":"elbow","startCap":"none","endCap":"triangleArrow",
        });
        connectors::settings(&mut connector, &options)?;
        let (node, _, commands) = connectors::build(
            &self.snapshot.nodes[root],
            append_rank(&self.snapshot, root)?,
            connector,
            label,
        )?;
        for command in commands {
            if let Command::NodeCreate { node: created } = command {
                let top = created.id == node.id;
                self.add(created, top);
            }
        }
        Ok(())
    }
}

fn retrospective(b: &mut Builder<'_>) -> Result<()> {
    b.title("Retrospective")?;
    let parts = [
        (
            "Went well",
            "#eaf6e1",
            "green",
            ["Something that helped us", "A win worth repeating"],
        ),
        (
            "To improve",
            "#fce8ef",
            "pink",
            ["Something that slowed us down", "A question we still have"],
        ),
        (
            "Next steps",
            "#e6f0fc",
            "blue",
            ["One change to try next", "Who looks after it?"],
        ),
    ];
    for (i, (name, fill, color, notes)) in parts.into_iter().enumerate() {
        let section = b.section(name, (i as f64 * 440., 72., 400., 520.), fill)?;
        for (j, note) in notes.into_iter().enumerate() {
            b.sticky(Some(&section), (100., 60. + j as f64 * 230.), note, color)?;
        }
    }
    Ok(())
}

fn brainstorm(b: &mut Builder<'_>) -> Result<()> {
    let topic = b.shape(
        "ellipse",
        (532., 300., 280., 160.),
        "What are we trying to solve?",
        "violet",
    )?;
    for ((x, y), color, first_near) in [
        ((0., 0.), "yellow", false),
        ((920., 0.), "orange", true),
        ((0., 560.), "green", false),
        ((920., 560.), "blue", true),
    ] {
        let first = b.sticky(None, (x, y), "An idea", color)?;
        let second = b.sticky(None, (x + 224., y), "Build on it", color)?;
        b.join(
            &topic,
            if first_near { &first } else { &second },
            json!({"style":"straight","endCap":"none"}),
            None,
        )?;
    }
    Ok(())
}

fn weekly(b: &mut Builder<'_>) -> Result<()> {
    b.title("This week")?;
    let days = [
        ("Monday", "Plan the week"),
        ("Tuesday", "Focus for the day"),
        ("Wednesday", "Focus for the day"),
        ("Thursday", "Focus for the day"),
        ("Friday", "Wrap up and share"),
    ];
    for (i, (day, note)) in days.into_iter().enumerate() {
        let section = b.section(day, (i as f64 * 280., 72., 260., 560.), "#ffffff")?;
        b.sticky(
            Some(&section),
            (30., 60.),
            note,
            if i % 2 == 0 { "yellow" } else { "orange" },
        )?;
    }
    Ok(())
}

fn flow(b: &mut Builder<'_>) -> Result<()> {
    let start = b.shape("ellipse", (0., 30., 160., 100.), "Start", "green")?;
    let step = b.shape(
        "rectangle",
        (240., 20., 180., 120.),
        "Do the first step",
        "blue",
    )?;
    let check = b.shape("diamond", (500., 0., 200., 160.), "Did it work?", "yellow")?;
    let carry = b.shape(
        "roundedRectangle",
        (800., 20., 180., 120.),
        "Carry on",
        "blue",
    )?;
    let done = b.shape("ellipse", (1060., 30., 160., 100.), "Done", "green")?;
    let other = b.shape(
        "roundedRectangle",
        (510., 240., 180., 120.),
        "Try another way",
        "orange",
    )?;
    b.join(&start, &step, json!({}), None)?;
    b.join(&step, &check, json!({}), None)?;
    b.join(&check, &carry, json!({}), Some("Yes"))?;
    b.join(&carry, &done, json!({}), None)?;
    b.join(
        &check,
        &other,
        json!({"fromSide":"bottom","toSide":"top"}),
        Some("No"),
    )?;
    b.join(
        &other,
        &step,
        json!({"fromSide":"left","toSide":"bottom"}),
        None,
    )
}

fn kanban(b: &mut Builder<'_>) -> Result<()> {
    b.title("Team board")?;
    let columns: [(&str, &str, &[&str]); 3] = [
        (
            "To do",
            "yellow",
            &[
                "Write the brief",
                "Sketch the first screens",
                "Plan a test session",
            ],
        ),
        ("Doing", "blue", &["Review the copy"]),
        ("Done", "green", &["Set up the board"]),
    ];
    for (i, (name, color, cards)) in columns.into_iter().enumerate() {
        let section = b.section(name, (i as f64 * 310., 72., 280., 740.), "#ffffff")?;
        for (j, card) in cards.iter().enumerate() {
            b.sticky(Some(&section), (40., 60. + j as f64 * 220.), card, color)?;
        }
    }
    Ok(())
}
