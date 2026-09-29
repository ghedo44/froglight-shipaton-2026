declare module '*?url' {
  const url: string;
  export default url;
}

declare module '*.css?inline' {
  const css: string;
  export default css;
}

declare module '*.module.css' {
  const classes: { readonly [key: string]: string };
  export default classes;
}

// Plain provider stylesheets imported for side effects
// (react/PdfReaderSkeleton.css). Declared after '*.module.css' so module
// imports keep their class mapping.
declare module '*.css';
