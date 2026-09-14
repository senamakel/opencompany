//! Draws an [`App`] into a frame. Layout only; no state lives here.

use ratatui::Frame;
use ratatui::layout::{Constraint, Layout};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, List, ListItem, ListState, Paragraph};

use crate::app::{App, HostStatus};

pub fn draw(frame: &mut Frame<'_>, app: &App) {
    let [header, body, footer] = Layout::vertical([
        Constraint::Length(5),
        Constraint::Min(3),
        Constraint::Length(1),
    ])
    .areas(frame.area());

    frame.render_widget(host_block(app), header);

    let [companies, log] =
        Layout::horizontal([Constraint::Percentage(40), Constraint::Percentage(60)]).areas(body);
    let mut list_state = ListState::default();
    if !app.companies.is_empty() {
        list_state.select(Some(app.selected));
    }
    frame.render_stateful_widget(company_list(app), companies, &mut list_state);
    frame.render_widget(log_block(app, log.height as usize), log);

    frame.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled(" q ", Style::default().add_modifier(Modifier::BOLD)),
            Span::raw("quit  "),
            Span::styled(" j/k ↑/↓ ", Style::default().add_modifier(Modifier::BOLD)),
            Span::raw("select"),
        ])),
        footer,
    );
}

fn host_block(app: &App) -> Paragraph<'_> {
    let lines = match &app.host {
        HostStatus::Starting => vec![Line::from(Span::styled(
            "starting the host…",
            Style::default().fg(Color::Yellow),
        ))],
        HostStatus::Ready {
            address,
            instance_id,
            home,
        } => vec![
            Line::from(vec![Span::raw("api       "), Span::raw(address.as_str())]),
            Line::from(vec![
                Span::raw("instance  "),
                Span::raw(instance_id.as_str()),
            ]),
            Line::from(vec![Span::raw("home      "), Span::raw(home.as_str())]),
        ],
        HostStatus::Failed(reason) => vec![Line::from(Span::styled(
            format!("host failed: {reason}"),
            Style::default().fg(Color::Red),
        ))],
    };
    Paragraph::new(lines).block(Block::bordered().title(" OpenCompany "))
}

fn company_list(app: &App) -> List<'_> {
    let items: Vec<ListItem<'_>> = if app.companies.is_empty() {
        vec![ListItem::new(Span::styled(
            "no companies yet",
            Style::default().fg(Color::DarkGray),
        ))]
    } else {
        app.companies
            .iter()
            .map(|row| {
                let status = if row.busy { " ● busy" } else { "" };
                ListItem::new(Line::from(vec![
                    Span::raw(row.id.as_str()),
                    Span::styled(status, Style::default().fg(Color::Green)),
                ]))
            })
            .collect()
    };
    List::new(items)
        .block(Block::bordered().title(format!(" companies ({}) ", app.companies.len())))
        .highlight_style(Style::default().add_modifier(Modifier::REVERSED))
        .highlight_symbol("> ")
}

fn log_block(app: &App, height: usize) -> Paragraph<'_> {
    // Show the tail: the newest lines are the ones that matter, and the pane
    // has no scrollback of its own.
    let visible = height.saturating_sub(2);
    let start = app.log.len().saturating_sub(visible);
    let lines: Vec<Line<'_>> = app.log[start..]
        .iter()
        .map(|line| Line::from(line.as_str()))
        .collect();
    Paragraph::new(lines).block(Block::bordered().title(" log "))
}
