use super::*;

const MAX_ROWS: usize = 50;
const MAX_COLUMNS: usize = 20;
const CELL_WIDTH: f64 = 160.;
const CELL_HEIGHT: f64 = 40.;
const HEADER: &str = "#f1efeb";

pub(super) fn command(context: &Context, action: &str) -> Result<Value> {
    if action == "table" {
        return create(context);
    }
    let mut target = context.one()?;
    let table = loop {
        let node = &context.snapshot.nodes[&target];
        if node.string(TYPE) == Some("table") {
            break node;
        }
        target = node
            .parent_id
            .clone()
            .ok_or_else(|| EngineError::invalid("Choose a table or a cell"))?;
    };
    let row_nodes = children(context.snapshot, &table.id);
    let mut rows = row_nodes
        .into_iter()
        .filter(|node| node.string(TYPE) == Some("tableRow"))
        .cloned()
        .collect::<Vec<_>>();
    let mut cells = rows
        .iter()
        .map(|row| {
            children(context.snapshot, &row.id)
                .into_iter()
                .filter(|node| node.string(TYPE) == Some("tableCell"))
                .cloned()
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    let mut texts = cells
        .iter()
        .map(|cells| {
            cells
                .iter()
                .map(|cell| {
                    children(context.snapshot, &cell.id)
                        .into_iter()
                        .find(|node| node.kind == NodeKind::Text)
                        .map(|node| node.id.clone())
                })
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    let columns = cells
        .first()
        .map(Vec::len)
        .filter(|&n| n > 0)
        .ok_or_else(|| EngineError::invalid("Table has no cells"))?;
    if cells.iter().any(|row| row.len() != columns) {
        return Err(EngineError::invalid(
            "Table rows have inconsistent cell counts",
        ));
    }
    let mut edits = Vec::new();
    let operation = string(context.params, "action")?;
    let old_width = table.number("width", CELL_WIDTH * columns as f64);
    let cell_width = old_width / columns as f64;
    let mut new_columns = columns;
    let index_for = |end: usize| -> Result<usize> {
        if context.params["index"].is_null() {
            return Ok(end);
        }
        let i = index(context.params, "index")?;
        if i > end {
            return Err(EngineError::invalid(format!(
                "index must be between 0 and {end}"
            )));
        }
        Ok(i)
    };
    match operation {
        "addRow" if rows.len() < MAX_ROWS => {
            let i = index_for(rows.len())?;
            let (row, new_cells, new_texts) = make_row(
                table,
                rank_at(&rows, i)?,
                cell_width,
                &vec![""; columns],
                i == 0,
                &mut edits,
            )?;
            rows.insert(i, row);
            cells.insert(i, new_cells);
            texts.insert(i, new_texts);
        }
        "removeRow" if rows.len() > 1 => {
            let i = index_for(rows.len() - 1)?;
            edits.push(Command::NodeDelete {
                node_ids: vec![rows.remove(i).id],
            });
            cells.remove(i);
            texts.remove(i);
        }
        "addColumn" if columns < MAX_COLUMNS => {
            let i = index_for(columns)?;
            for ((row, cells), texts) in rows.iter().zip(&mut cells).zip(&mut texts) {
                let (cell, text) = make_cell(row, rank_at(cells, i)?, cell_width, "", &mut edits)?;
                cells.insert(i, cell);
                texts.insert(i, Some(text));
            }
            new_columns += 1;
        }
        "removeColumn" if columns > 1 => {
            let i = index_for(columns - 1)?;
            for (cells, texts) in cells.iter_mut().zip(&mut texts) {
                edits.push(Command::NodeDelete {
                    node_ids: vec![cells.remove(i).id],
                });
                texts.remove(i);
            }
            new_columns -= 1;
        }
        "addRow" | "removeRow" | "addColumn" | "removeColumn" => {
            return Err(EngineError::invalid(
                "Table must keep 1–50 rows and 1–20 columns",
            ));
        }
        _ => {
            return Err(EngineError::invalid(
                "action must be addRow, removeRow, addColumn or removeColumn",
            ));
        }
    }
    if new_columns != columns {
        edits.push(context.patch(&table.id, "width", json!(new_columns as f64 * cell_width)));
    }
    for (index, row) in rows.iter().enumerate() {
        let fill = if index == 0 { HEADER } else { "transparent" };
        if row.string("fill") != Some(fill) {
            edits.push(context.patch(&row.id, "fill", json!(fill)));
        }
    }
    context.commit(edits)?;
    Ok(response(context, &table.id, &texts))
}

fn create(context: &Context) -> Result<Value> {
    let params = context.params;
    let given = if params["cells"].is_null() {
        Vec::new()
    } else {
        params["cells"]
            .as_array()
            .filter(|rows| rows.len() <= MAX_ROWS)
            .ok_or_else(|| EngineError::invalid("cells must be a list of up to 50 rows"))?
            .iter()
            .map(|row| {
                row.as_array()
                    .filter(|row| row.len() <= MAX_COLUMNS)
                    .ok_or_else(|| EngineError::invalid("Each row must hold up to 20 text cells"))?
                    .iter()
                    .map(|text| {
                        text.as_str()
                            .filter(|text| text.chars().count() <= 4096)
                            .ok_or_else(|| {
                                EngineError::invalid("Cells must be text of up to 4096 characters")
                            })
                    })
                    .collect::<Result<Vec<_>>>()
            })
            .collect::<Result<Vec<_>>>()?
    };
    let widest = given.iter().map(Vec::len).max().unwrap_or(0);
    let rows = if params["rows"].is_null() {
        if given.is_empty() { 3 } else { given.len() }
    } else {
        index(params, "rows")?
    };
    let columns = if params["columns"].is_null() {
        if widest == 0 { 3 } else { widest }
    } else {
        index(params, "columns")?
    };
    if !(1..=MAX_ROWS).contains(&rows)
        || !(1..=MAX_COLUMNS).contains(&columns)
        || rows < given.len()
        || columns < widest
    {
        return Err(EngineError::invalid(
            "Cells must fit the requested table dimensions (1–50 rows, 1–20 columns)",
        ));
    }
    let width = columns as f64 * CELL_WIDTH;
    let (x, y) = (
        number(params, "x", (1440. - width) / 2.)?,
        number(params, "y", (900. - rows as f64 * CELL_HEIGHT) / 2.)?,
    );
    let root = &context.snapshot.nodes[&context.state.root];
    let table = new_layer(
        NodeKind::Frame,
        root,
        append_rank(context.snapshot, &root.id)?,
        json!({
            "name":"Table","x":x,"y":y,"width":width,"fill":"#ffffff","radius":4.,"clipContent":true,
            "boardItemType":"table","style":{"position":"absolute","display":"flex","flex-direction":"column"},
        }),
    )?;
    let mut edits = vec![Command::NodeCreate {
        node: table.clone(),
    }];
    let mut result = Vec::with_capacity(rows);
    for row in 0..rows {
        let texts = (0..columns)
            .map(|col| {
                given
                    .get(row)
                    .and_then(|row| row.get(col))
                    .copied()
                    .unwrap_or("")
            })
            .collect::<Vec<_>>();
        let (_, _, text_ids) = make_row(
            &table,
            initial_rank(row),
            CELL_WIDTH,
            &texts,
            row == 0,
            &mut edits,
        )?;
        result.push(text_ids);
    }
    context.commit(edits)?;
    select(context, &table.id);
    Ok(response(context, &table.id, &result))
}

fn rank_at(nodes: &[Node], i: usize) -> Result<String> {
    rank_between(
        i.checked_sub(1)
            .and_then(|i| nodes.get(i))
            .map(|node| node.rank.as_str()),
        nodes.get(i).map(|node| node.rank.as_str()),
    )
    .ok_or_else(|| EngineError::new("resource_limit", "Table ranks need rebalancing"))
}

fn initial_rank(index: usize) -> String {
    format!("{:032x}", (index as u128 + 1) << 112)
}

fn make_row(
    table: &Node,
    rank: String,
    cell_width: f64,
    texts: &[&str],
    header: bool,
    edits: &mut Vec<Command>,
) -> Result<(Node, Vec<Node>, Vec<Option<String>>)> {
    let row = new_layer(
        NodeKind::Frame,
        table,
        rank,
        json!({
            "name":"Row","fill":if header {HEADER} else {"transparent"},"boardItemType":"tableRow",
            "style":{"display":"flex","flex-direction":"row","align-items":"stretch","min-height":"40px","flex-shrink":"0"},
        }),
    )?;
    edits.push(Command::NodeCreate { node: row.clone() });
    let mut cells = Vec::with_capacity(texts.len());
    let mut ids = Vec::with_capacity(texts.len());
    for (i, text) in texts.iter().enumerate() {
        let (cell, label) = make_cell(&row, initial_rank(i), cell_width, text, edits)?;
        cells.push(cell);
        ids.push(Some(label));
    }
    Ok((row, cells, ids))
}

fn make_cell(
    row: &Node,
    rank: String,
    width: f64,
    text: &str,
    edits: &mut Vec<Command>,
) -> Result<(Node, String)> {
    let cell = new_layer(
        NodeKind::Frame,
        row,
        rank,
        json!({
            "name":"Cell","width":width,"boardItemType":"tableCell","stroke":"#cfcbc4","strokeWidth":1.,
            "style":{"display":"flex","flex-direction":"column","min-height":"40px","padding":"10px 12px","flex-shrink":"0"},
        }),
    )?;
    let label = new_layer(
        NodeKind::Text,
        &cell,
        initial_rank(0),
        json!({
            "name":"Text","text":text,"width":(width-24.).max(1.),"fontSize":14.,"fill":"#292724",
            "style":{"flex-shrink":"0"},
        }),
    )?;
    edits.extend([
        Command::NodeCreate { node: cell.clone() },
        Command::NodeCreate {
            node: label.clone(),
        },
    ]);
    Ok((cell, label.id))
}

fn response(context: &Context, table: &str, cells: &[Vec<Option<String>>]) -> Value {
    let ids = cells
        .iter()
        .map(|row| {
            row.iter()
                .map(|cell| cell.as_ref().map(|id| context.alias(id)))
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    json!({"id":context.alias(table),"rows":cells.len(),"columns":cells.first().map_or(0,Vec::len),"cells":ids})
}
