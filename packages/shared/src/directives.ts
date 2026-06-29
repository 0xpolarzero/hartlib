import { Schema } from "effect";
import { ArtifactDirective } from "./artifacts";

export const DirectiveName = Schema.Literal("artifact");
export type DirectiveName = Schema.Schema.Type<typeof DirectiveName>;

export const Directive = Schema.Struct({
  name: DirectiveName,
  attributes: ArtifactDirective,
  raw: Schema.String,
  start: Schema.Number,
  end: Schema.Number,
});

export type Directive = Schema.Schema.Type<typeof Directive>;

const directivePattern = /^::artifact\{([^}]*)\}\s*$/gm;
const attributePattern = /([A-Za-z][A-Za-z0-9_-]*)="([^"]*)"/g;

const parseAttributes = (source: string): Record<string, string> => {
  const attributes: Record<string, string> = {};

  for (const match of source.matchAll(attributePattern)) {
    const [, key, value] = match;
    if (key !== undefined && value !== undefined) {
      attributes[key] = value;
    }
  }

  return attributes;
};

export const parseDirectives = (markdown: string): ReadonlyArray<Directive> => {
  const decodeArtifactDirective = Schema.decodeUnknownSync(ArtifactDirective);
  const directives: Array<Directive> = [];

  for (const match of markdown.matchAll(directivePattern)) {
    const [raw, rawAttributes] = match;
    if (raw === undefined || rawAttributes === undefined || match.index === undefined) {
      continue;
    }

    directives.push({
      name: "artifact",
      attributes: decodeArtifactDirective(parseAttributes(rawAttributes)),
      raw,
      start: match.index,
      end: match.index + raw.length,
    });
  }

  return directives;
};
