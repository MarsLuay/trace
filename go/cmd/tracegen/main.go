// Command tracegen instruments owned Go function bodies with trace_runtime.Enter.
package main

import (
	"flag"
	"fmt"
	"go/ast"
	"go/format"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

func main() {
	root := flag.String("root", ".", "project root")
	runtimeImport := flag.String("runtime-import", "trace_runtime", "trace runtime import path")
	write := flag.Bool("write", false, "rewrite files in place")
	flag.Parse()
	if !*write {
		fmt.Fprintln(os.Stderr, "tracegen: refusing to mutate files without -write")
		os.Exit(2)
	}
	count := 0
	err := filepath.Walk(*root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			if path != *root && excludedDirectory(path) {
				return filepath.SkipDir
			}
			return nil
		}
		if filepath.Ext(path) != ".go" || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		changed, transformErr := transformFile(path, *root, *runtimeImport)
		if transformErr != nil {
			return transformErr
		}
		if changed {
			count++
		}
		return nil
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, "tracegen:", err)
		os.Exit(1)
	}
	fmt.Printf("tracegen: instrumented %d files\n", count)
}

func excludedDirectory(path string) bool {
	for _, segment := range strings.Split(filepath.ToSlash(path), "/") {
		if segment == ".git" || segment == "vendor" || segment == "generated" || segment == "build" || segment == "dist" || segment == "target" {
			return true
		}
	}
	return false
}

func transformFile(path, root, runtimeImport string) (bool, error) {
	contents, err := os.ReadFile(path)
	if err != nil {
		return false, err
	}
	if strings.Contains(string(contents), "Code generated") || strings.Contains(string(contents), "trace_runtime.Enter") {
		return false, nil
	}
	fileset := token.NewFileSet()
	file, err := parser.ParseFile(fileset, path, contents, parser.ParseComments)
	if err != nil {
		return false, err
	}
	changed := false
	needsContext := false
	for _, declaration := range file.Decls {
		function, ok := declaration.(*ast.FuncDecl)
		if !ok || function.Body == nil {
			continue
		}
		parameter := contextParameter(function)
		if parameter == "" {
			needsContext = true
		}
		line := fileset.Position(function.Pos()).Line
		contextExpression := ast.Expr(ast.NewIdent(parameter))
		if parameter == "" {
			contextExpression = &ast.CallExpr{Fun: &ast.SelectorExpr{X: ast.NewIdent("context"), Sel: ast.NewIdent("Background")}}
		}
		assignmentContext := ast.NewIdent(parameter)
		if parameter == "" {
			assignmentContext = ast.NewIdent("_")
		}
		endName := ast.NewIdent("__traceEnd")
		call := &ast.CallExpr{
			Fun:  &ast.SelectorExpr{X: ast.NewIdent("trace_runtime"), Sel: ast.NewIdent("Enter")},
			Args: []ast.Expr{contextExpression, &ast.BasicLit{Kind: token.STRING, Value: strconv.Quote(filepath.ToSlash(relativePath(root, path)))}, &ast.BasicLit{Kind: token.INT, Value: fmt.Sprint(line)}, &ast.BasicLit{Kind: token.STRING, Value: strconv.Quote(function.Name.Name)}, &ast.BasicLit{Kind: token.STRING, Value: strconv.Quote("")}},
		}
		function.Body.List = append([]ast.Stmt{
			&ast.AssignStmt{Lhs: []ast.Expr{assignmentContext, endName}, Tok: token.DEFINE, Rhs: []ast.Expr{call}},
			&ast.DeferStmt{Call: &ast.CallExpr{Fun: endName}},
		}, function.Body.List...)
		changed = true
	}
	if !changed {
		return false, nil
	}
	ensureImport(file, runtimeImport, "trace_runtime")
	if needsContext {
		ensureImport(file, "context", "context")
	}
	var builder strings.Builder
	if err := format.Node(&builder, fileset, file); err != nil {
		return false, err
	}
	return true, os.WriteFile(path, []byte(builder.String()), 0o644)
}

func relativePath(root, path string) string {
	relative, err := filepath.Rel(root, path)
	if err != nil {
		return filepath.Base(path)
	}
	return relative
}

func contextParameter(function *ast.FuncDecl) string {
	if function.Type.Params == nil {
		return ""
	}
	for _, field := range function.Type.Params.List {
		for _, name := range field.Names {
			if name.Name == "ctx" {
				return name.Name
			}
		}
	}
	return ""
}

func ensureImport(file *ast.File, path, name string) {
	for _, importSpec := range file.Imports {
		if strings.Trim(importSpec.Path.Value, "\"") == path {
			return
		}
	}
	file.Imports = append(file.Imports, &ast.ImportSpec{Name: ast.NewIdent(name), Path: &ast.BasicLit{Kind: token.STRING, Value: strconv.Quote(path)}})
	file.Decls = append([]ast.Decl{&ast.GenDecl{Tok: token.IMPORT, Specs: []ast.Spec{file.Imports[len(file.Imports)-1]}}}, file.Decls...)
}
