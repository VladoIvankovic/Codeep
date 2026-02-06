#!/usr/bin/env node
import { readdir, readFile, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const distDir = join(__dirname, '../dist');

async function* getFiles(dir) {
  const dirents = await readdir(dir, { withFileTypes: true });
  for (const dirent of dirents) {
    const res = join(dir, dirent.name);
    if (dirent.isDirectory()) {
      yield* getFiles(res);
    } else if (dirent.name.endsWith('.js')) {
      yield res;
    }
  }
}

async function fixImports() {
  for await (const file of getFiles(distDir)) {
    let content = await readFile(file, 'utf-8');
    
    // Fix relative imports: from './module' to './module.js'
    // If path ends with a directory name (no extension), try index.js first
    content = content.replace(
      /from\s+['"](\.[^'"]+)['"]/g,
      (match, path) => {
        if (path.endsWith('.js') || path.endsWith('.json')) {
          return match;
        }
        // Check if it's importing a directory (e.g., './config' -> './config/index.js')
        const fullPath = join(dirname(file), path);
        try {
          const stat = require('fs').statSync(fullPath);
          if (stat.isDirectory()) {
            return match.replace(path, `${path}/index.js`);
          }
        } catch (e) {
          // Not a directory, treat as file
        }
        return match.replace(path, `${path}.js`);
      }
    );
    
    // Fix import statements: import './module' to import './module.js'
    content = content.replace(
      /import\s+['"](\.[^'"]+)['"]/g,
      (match, path) => {
        if (path.endsWith('.js') || path.endsWith('.json')) {
          return match;
        }
        const fullPath = join(dirname(file), path);
        try {
          const stat = require('fs').statSync(fullPath);
          if (stat.isDirectory()) {
            return match.replace(path, `${path}/index.js`);
          }
        } catch (e) {
          // Not a directory, treat as file
        }
        return match.replace(path, `${path}.js`);
      }
    );
    
    // Fix dynamic imports: await import('./module') to await import('./module.js')
    content = content.replace(
      /import\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g,
      (match, path) => {
        if (path.endsWith('.js') || path.endsWith('.json')) {
          return match;
        }
        const fullPath = join(dirname(file), path);
        try {
          const stat = require('fs').statSync(fullPath);
          if (stat.isDirectory()) {
            return match.replace(path, `${path}/index.js`);
          }
        } catch (e) {
          // Not a directory, treat as file
        }
        return match.replace(path, `${path}.js`);
      }
    );
    
    await writeFile(file, content, 'utf-8');
  }
  
  console.log('✓ Fixed all imports in dist/');
}

fixImports().catch(console.error);
