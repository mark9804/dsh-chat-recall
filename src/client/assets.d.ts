/** esbuild's text loader keeps styles component-scoped; it does not inject global CSS. */
declare module '*.css' {
  const css: string;
  export default css;
}
