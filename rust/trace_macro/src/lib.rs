use proc_macro::{Delimiter, Group, TokenStream, TokenTree};
use std::str::FromStr;

#[proc_macro_attribute]
pub fn trace(_attribute: TokenStream, item: TokenStream) -> TokenStream {
    let mut tokens: Vec<TokenTree> = item.into_iter().collect();
    let mut function_name = None;
    let mut saw_function = false;
    let mut saw_name = false;
    let mut body_index = None;

    for (index, token) in tokens.iter().enumerate() {
        match token {
            TokenTree::Ident(identifier) if identifier.to_string() == "fn" => saw_function = true,
            TokenTree::Ident(identifier) if saw_function && !saw_name => {
                function_name = Some(identifier.to_string());
                saw_name = true;
            }
            TokenTree::Group(group) if saw_name && group.delimiter() == Delimiter::Brace => {
                body_index = Some(index);
                break;
            }
            _ => {}
        }
    }

    let Some(body_index) = body_index else {
        return "compile_error!(\"trace attribute requires a function item\");".parse().expect("valid compile error");
    };
    let name = function_name.unwrap_or_else(|| "anonymous".into());
    let statement = TokenStream::from_str(&format!(
        "let __trace_guard = ::trace_runtime::TraceGuard::enter(file!(), line!(), \"{}\", \"\");",
        name.replace('"', "\\\"")
    )).expect("generated trace guard must parse");
    let old_body = match &tokens[body_index] {
        TokenTree::Group(group) => group.stream(),
        _ => unreachable!(),
    };
    let mut body = statement;
    body.extend(old_body);
    let mut group = Group::new(Delimiter::Brace, body);
    if let TokenTree::Group(old) = &tokens[body_index] {
        group.set_span(old.span());
    }
    tokens[body_index] = TokenTree::Group(group);
    tokens.into_iter().collect()
}
