// The package exposes these entry points, while its community types currently
// describe the root API only. Importing them avoids unused lexer dictionaries.
declare module 'css-tree/parser' {
  export { parse as default } from 'css-tree';
}
declare module 'css-tree/generator' {
  export { generate as default } from 'css-tree';
}
declare module 'css-tree/walker' {
  export { walk as default } from 'css-tree';
}
