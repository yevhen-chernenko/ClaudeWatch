// SPDX-License-Identifier: GPL-2.0-or-later
//
// Only ever run with --fix against the compiled output in dist/ (see the
// `format:dist` script): tsc drops blank lines between functions, classes and
// class members from its emitted JS, and extension reviewers read that JS.
import stylistic from "@stylistic/eslint-plugin";

export default [
  {
    files: ["dist/**/*.js"],
    plugins: { "@stylistic": stylistic },
    rules: {
      "@stylistic/lines-between-class-members": [
        "error",
        {
          enforce: [
            { blankLine: "always", prev: "method", next: "*" },
            { blankLine: "always", prev: "*", next: "method" },
          ],
        },
      ],
      "@stylistic/padding-line-between-statements": [
        "error",
        {
          blankLine: "always",
          prev: "*",
          next: ["function", "class", "export"],
        },
        {
          blankLine: "always",
          prev: ["function", "class", "export"],
          next: "*",
        },
      ],
    },
  },
];
