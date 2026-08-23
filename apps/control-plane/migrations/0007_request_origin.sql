-- Country of the request, for the operator's own usage log.
--
-- Country only, never an IP. Cloudflare resolves this at the edge and hands it
-- over as a two-letter code, so the application never sees, processes, or has
-- the option of storing an address. Two letters cannot identify a person, and
-- the privacy page can keep saying addresses are not persisted because they
-- still are not.
--
-- Nullable: requests created before this column existed have no country, and
-- direct or unresolvable origins legitimately have none either.
ALTER TABLE scan_requests ADD COLUMN country TEXT
  CHECK (country IS NULL OR length(country) = 2);
