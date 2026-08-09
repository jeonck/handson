// HCL / Terraform grammar for highlight.js.
//
// highlight.js ships no HCL language and there is no published third-party package for it
// (highlightjs-terraform and friends are all 404 on npm as of 2026-08), so this is hand-written.
// Keep it small: it exists to make `.tf` files readable on the site, not to be a parser.
//
// Known limit, so nobody debugs it twice:
//  - Block labels are styled as strings, because that is what they are syntactically; the
//    resource type in `resource "aws_s3_bucket" "x"` gets no special colour of its own.

export default function hcl(hljs) {
  const IDENT = /[A-Za-z_][A-Za-z0-9_-]*/;

  // Namespaces that start a reference: var.x, local.y, path.module, each.value.
  const REFERENCE = {
    className: "variable",
    begin: /\b(var|local|module|data|each|count|path|self|terraform)\.[\w.-]+/,
  };

  const INTERPOLATION = {
    className: "subst",
    begin: /\$\{/,
    end: /\}/,
    // Control words only. `var`/`local` belong to REFERENCE, or they end up a different
    // colour inside ${...} than the same reference written outside it.
    keywords: { keyword: "for in if else endif" },
    contains: [
      REFERENCE,
      { className: "built_in", begin: /\b[a-z][a-z0-9_]*(?=\()/ },
      { className: "string", begin: /"/, end: /"/, contains: [{ begin: /\\./ }] },
    ],
  };

  return {
    name: "HCL",
    aliases: ["tf", "terraform", "tfvars"],
    keywords: {
      keyword:
        "resource data variable output locals module provider terraform provisioner connection " +
        "backend dynamic lifecycle depends_on count for_each for in if else endif can try",
      literal: "true false null",
    },
    contains: [
      hljs.COMMENT("#", "$"),
      hljs.COMMENT("//", "$"),
      hljs.COMMENT("/\\*", "\\*/"),

      // Heredoc: <<EOF, <<-EOF, <<~EOF.
      // The terminator has to match the opener, and highlight.js cannot backreference a
      // `begin` capture from `end` — writing /^\s*\1\s*$/ swallows the rest of the file.
      // The on:begin / on:end pair carries the opener across and rejects any other lone word,
      // so a heredoc body containing one no longer ends the block early.
      {
        className: "string",
        begin: /<<[-~]?([A-Za-z_][A-Za-z0-9_]*)/,
        end: /^\s*[A-Za-z_][A-Za-z0-9_]*\s*$/,
        "on:begin": (m, resp) => {
          resp.data._tag = m[1];
        },
        "on:end": (m, resp) => {
          if (m[0].trim() !== resp.data._tag) resp.ignoreMatch();
        },
        contains: [INTERPOLATION],
        relevance: 10,
      },

      { className: "string", begin: /"/, end: /"/, contains: [{ begin: /\\./ }, INTERPOLATION] },

      // attribute = value, and the `key =` of a nested block body
      { className: "attr", begin: new RegExp(`^\\s*${IDENT.source}(?=\\s*=[^=])`) },

      // function call: jsonencode(, file(, cidrsubnet(
      { className: "built_in", begin: /\b[a-z][a-z0-9_]*(?=\()/, relevance: 0 },

      REFERENCE,

      { className: "number", begin: /\b\d+(\.\d+)?\b/, relevance: 0 },
    ],
  };
}
