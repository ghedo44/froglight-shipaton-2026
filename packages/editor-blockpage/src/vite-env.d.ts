declare module '*.css?inline' {
  const css: string;
  export default css;
}

declare module '*.module.css' {
  const classes: { readonly [key: string]: string };
  export default classes;
}

// Plain global provider stylesheets imported for side effects
// (styles/prose-mirror.css). Declared after '*.module.css' so module
// imports keep their class mapping.
declare module '*.css';
