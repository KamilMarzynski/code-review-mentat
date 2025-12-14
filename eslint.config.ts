import { FlatCompat } from '@eslint/eslintrc';
import path from 'path';
import { fileURLToPath } from 'url';

const filename = fileURLToPath(import.meta.url);
const dirname = path.dirname(filename);

const compat = new FlatCompat({
  baseDirectory: dirname,
});

export default [
  // Non-React projects
  ...compat.extends('airbnb-base'),
  ...compat.extends('airbnb-typescript/base'),
  // Configure TypeScript parser
  {
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: dirname,
      },
    },
  },
];
