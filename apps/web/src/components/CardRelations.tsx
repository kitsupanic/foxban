import { useState } from "react";
import { ChevronDown, Link, Plus, X } from "lucide-react";
import type { Card, CardRelation } from "@foxban/shared";
import type { BoardCommands } from "../lib/board-commands";
import { RELATION_OPTIONS, relationViews, cardTitle, type RelationOptionValue } from "../lib/relations";
import { relationCardMatches } from "../lib/task-key";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

/**
 * The link composer's state, called by the modal rather than the section: the two shells wrap the
 * body differently, so a view switch is not guaranteed to keep a section's own state, and a
 * half-typed link must survive it. Collapsed like the comment composer until asked for, then the
 * direction to store plus the picker's search text.
 */
export function useCardRelations(
  commands: Pick<BoardCommands, "createRelation">,
  { cardId, relations, cards, boardKey }: { cardId: string; relations: CardRelation[]; cards: Card[]; boardKey?: string },
) {
  const [composing, setComposing] = useState(false);
  const [kind, setKind] = useState<RelationOptionValue>("relates");
  const [query, setQuery] = useState("");
  // The picked card arrives straight from the autocomplete — no confirm button.
  // A duplicate pair is dropped silently; the DO does no referential checks.
  const add = (otherCardId: string) => {
    if (commands.createRelation(kind, cardId, otherCardId) !== "not-sent") setQuery("");
  };
  return {
    composing,
    setComposing,
    kind,
    setKind,
    query,
    setQuery,
    add,
    views: relationViews(relations, cardId),
    matches: relationCardMatches(cards, cardId, boardKey ?? "", query),
  };
}

export type CardRelationsState = ReturnType<typeof useCardRelations>;

// Keep secondary forms mounted so collapsing never drops their drafts.
export function CardRelations({
  link: { composing, setComposing, kind, setKind, query, setQuery, add, views, matches },
  cards,
  boardKey,
  commands,
  navigate,
}: {
  link: CardRelationsState;
  cards: Card[];
  boardKey?: string;
  commands: Pick<BoardCommands, "deleteRelation">;
  navigate: (cardId: string) => void;
}) {
  return (
    <details data-testid="card-relations-section" className="card-details-disclosure">
      <summary><h3><Link aria-hidden="true" className="card-section-icon" />Relations{views.length > 0 && ` ${views.length}`}</h3><ChevronDown aria-hidden="true" /></summary>
      <div className="card-sidebar-section card-disclosure-content flex flex-col gap-2">
      {views.length > 0 && (
        <ul className="flex flex-col gap-1">
          {views.map((view) => (
            <li
              key={view.relation.id}
              className="group flex items-center gap-2 text-sm text-foreground"
            >
              <button
                type="button"
                aria-label={`Open ${cardTitle(cards, view.otherCardId)}`}
                onClick={() => navigate(view.otherCardId)}
                className="min-w-0 flex-1 truncate text-left hover:underline"
              >
                <span className="text-muted-foreground">{view.label}</span>{" "}
                <span className="font-medium text-foreground">{cardTitle(cards, view.otherCardId)}</span>
              </button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Delete relation ${view.label} ${cardTitle(cards, view.otherCardId)}`}
                onClick={() => commands.deleteRelation(view.relation.id)}
                className="opacity-0 pointer-coarse:opacity-100 size-7 pointer-coarse:size-11 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 text-muted-foreground hover:text-destructive"
              >
                <X aria-hidden className="size-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {composing ? (
        <>
          <div className="flex items-center gap-2">
            <select
              aria-label="Relation kind"
              value={kind}
              onChange={(event) => setKind(event.target.value as RelationOptionValue)}
              className="h-8 flex-1 rounded-md border border-input bg-card px-2 py-1 text-base sm:text-sm text-card-foreground shadow-xs focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              {RELATION_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <Input
              autoFocus
              aria-label="Link a card"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              // Same reason as the checklist editor: the modal's Escape listener
              // sits on `window`, so both inner stages must stop here. Only once
              // the composer is gone does an Escape reach the modal.
              onKeyDown={(event) => {
                if (event.key === "Enter" && matches.length > 0) add(matches[0].id);
                if (event.key === "Escape") {
                  event.stopPropagation();
                  if (query !== "") setQuery("");
                  else setComposing(false);
                }
              }}
              placeholder="Search by title or task ID…"
              className="h-8 flex-1 bg-background text-base sm:text-sm text-foreground"
            />
          </div>
          {query.trim() !== "" &&
            (matches.length === 0 ? (
              <div className="text-sm text-muted-foreground">No matching cards</div>
            ) : (
              <ul data-testid="relation-results" className="flex flex-col gap-1">
                {matches.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => add(c.id)}
                      className="flex w-full items-center gap-2 truncate rounded-md px-2 py-1 text-left text-sm text-foreground hover:bg-accent hover:text-accent-foreground"
                    >
                      {boardKey && c.taskNumber > 0 && (
                        <span className="shrink-0 text-xs font-medium text-muted-foreground select-none">
                          {boardKey}-{c.taskNumber}
                        </span>
                      )}
                      <span className="truncate">{c.title}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ))}
        </>
      ) : (
        // Collapsed like the comment composer: linking is the rare act on
        // a card, and the picker is two controls wide.
        <Button
          type="button"
          aria-label="+ Link a card…"
          variant="secondary"
          size="sm"
          onClick={() => setComposing(true)}
          className="w-full justify-start text-muted-foreground hover:text-foreground"
        >
          <Plus aria-hidden="true" className="size-4" />Link a card
        </Button>
      )}
      </div>
    </details>
  );
}
