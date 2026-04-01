# Reusable Airbnb MCP primitives for search, comparison, and trip-session context.

This package is the public, developer-oriented MCP surface for Airbnb/travel workflows. It is built to be general, portable, LLM-agnostic, and easy to extend.

## What It Does

- search listings
- fetch normalized listing details
- compare options deterministically
- store trip-session context
- expose readable MCP resources for searches, listings, and trips
- provide generic prompts and agent-facing routing instructions

## Tools

- `airbnb_search`
- `airbnb_listing_details`
- `compare_listings`
- `build_candidate_set`
- `save_trip_constraints`
- `append_trip_decision`
- `save_shortlist`
- `clear_trip_session`

## Resources

- `airbnb://listing/{listingId}`
- `airbnb://listing/{listingId}/normalized`
- `airbnb://search/{searchId}/results`
- `airbnb://search/{searchId}/summary`
- `trip://{tripId}/constraints`
- `trip://{tripId}/candidate_set`
- `trip://{tripId}/shortlist`
- `trip://{tripId}/decision_log`

## Prompts

- `compare_top_listings`
- `build_trip_brief`
- `narrow_search`
- `explain_listing_tradeoffs`
- `public_agent_instructions`

`public_agent_instructions` is a generic agent-accessible layer. It gives route selection and session usage guidance without assuming a specific model, evaluator loop, or host policy.

## Context Layer

The public package keeps a context layer, but it is session-oriented and generic:

- trip constraints
- candidate set
- shortlist
- decision log
- derived summaries

It does not persist identity-heavy taste memory or hidden preference shaping.

## Build

```bash
npm run build:public
```

## Validate

```bash
npm run validate:public
```

## Extend

- Add custom scoring on top of `compare_listings`
- Swap the in-memory `SessionStore` for a durable storage backend
- Add host-specific prompts or route logic outside the server
- Build your own context parser on top of `save_trip_constraints`
