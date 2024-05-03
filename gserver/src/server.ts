'use strict';

import {
    IPCMessageReader,
    IPCMessageWriter,
    IConnection,
    createConnection,
    TextDocuments,
    InitializeResult,
    Diagnostic,
    TextDocumentPositionParams,
    CompletionItem,
    CompletionItemKind,
    Definition,
    Range,
    Position,
    DocumentFormattingParams,
    TextEdit,
    DocumentRangeFormattingParams,
    FormattingOptions,
    Location
} from 'vscode-languageserver';
import { format, clearText } from './format';
import StepsHandler from './steps.handler';
import PagesHandler from './pages.handler';
import { getOSPath, clearGherkinComments } from './util';
import * as glob from 'glob';
import * as fs from 'fs';

//Create connection and setup communication between the client and server
const connection: IConnection = createConnection(new IPCMessageReader(process), new IPCMessageWriter(process));
const documents: TextDocuments = new TextDocuments();
documents.listen(connection);
//Path to the root of our workspace
let workspaceRoot: string;
// Object, which contains current configuration
let settings: Settings;
// Elements handlers
let stepsHandler: StepsHandler;
let pagesHandler: PagesHandler;

connection.onInitialize((params): InitializeResult => {
    workspaceRoot = params.rootPath;
    return {
        capabilities: {
            // Full text sync mode
            textDocumentSync: documents.syncKind,
            //Completion will be triggered after every character pressing
            completionProvider: {
                resolveProvider: true,
                triggerCharacters: [' ']
            },
            definitionProvider: true,
            documentFormattingProvider: true,
            documentRangeFormattingProvider: true,
            documentOnTypeFormattingProvider: {
                firstTriggerCharacter: ' ',
                moreTriggerCharacter: ['@', '#', ':']
            }
        }
    };
});

function handleSteps(): boolean {
    const s = settings.cucumberautocomplete.steps;
    return s && s.length ? true : false;
}

function handlePages(): boolean {
    const p = settings.cucumberautocomplete.pages;
    return p && Object.keys(p).length ? true : false;
}

function pagesPosition(line: string, char: number): boolean {
    if (handlePages() && pagesHandler && pagesHandler.getFeaturePosition(line, char)) {
        return true;
    } else {
        return false;
    }
}

function watchFiles(stepsPathes: string[]): void {
    stepsPathes.forEach(path => {
        glob.sync(workspaceRoot + '/' + path, { ignore: '.gitignore' })
            .forEach(f => {
                fs.watchFile(f, () => {
                    populateHandlers();
                    documents.all().forEach((document) => {
                        const text = document.getText();
                        const diagnostics = validate(clearGherkinComments(text));
                        connection.sendDiagnostics({ uri: document.uri, diagnostics });
                    });
                });
            });
    });
}

connection.onDidChangeConfiguration(change => {
    settings = <Settings>change.settings;
    //We should get array from step string if provided
    settings.cucumberautocomplete.steps = Array.isArray(settings.cucumberautocomplete.steps)
        ? settings.cucumberautocomplete.steps : [settings.cucumberautocomplete.steps];
    if (handleSteps()) {
        watchFiles(settings.cucumberautocomplete.steps);
        stepsHandler = new StepsHandler(workspaceRoot, settings);
        const sFile = '.vscode/settings.json';
        const diagnostics = stepsHandler.validateConfiguration(sFile, settings.cucumberautocomplete.steps, workspaceRoot);
        connection.sendDiagnostics({ uri: getOSPath(workspaceRoot + '/' + sFile), diagnostics });
    }
    if (handlePages()) {
        const { pages } = settings.cucumberautocomplete;
        watchFiles(Object.keys(pages).map((key) => pages[key]));
        pagesHandler = new PagesHandler(workspaceRoot, settings);
    }
});

function populateHandlers() {
    handleSteps() && stepsHandler && stepsHandler.populate(workspaceRoot, settings.cucumberautocomplete.steps);
    handlePages() && pagesHandler && pagesHandler.populate(workspaceRoot, settings.cucumberautocomplete.pages);
}

documents.onDidOpen(() => {
    populateHandlers();
});

// Function to get the word before the cursor position in a line of text
function getWordBeforeCursor(line: string, char: number): string {
    const beforeCursor = line.slice(0, char).trim();
    const words = beforeCursor.split(/\s+/);
    return words.length > 0 ? words[words.length - 1] : "";
}

function findCaseHandlers(featureText) : CompletionItem[] {
    const lines = featureText.split(/\r?\n/);
    let inBackground = false;
    const completionItems = [];

    for (const line of lines) {
        // Check if the line starts with 'Background:'
        if (line.trim().startsWith('Background:')) {
            inBackground = true;
        }
        // Check if the line starts with 'Scenario:'
        else if (line.trim().startsWith('Scenario:')) {
            inBackground = false;
        }

        if (inBackground) {
            // Match lines starting with 'Given case' followed by a case handler name
            const caseHandlerMatch = line.trim().match(/^Given case (\S+)(?: with (taskguide \S+|case \S+))?/);
            if (caseHandlerMatch) {
                const caseHandler = caseHandlerMatch[1];
                const caseHandlerType = caseHandlerMatch[2];
                const insertText = caseHandler;

                const completionItem = {
                    label: caseHandler,
                    kind: CompletionItemKind.Variable,
                    documentation: caseHandlerType,
                    insertText: insertText,
                    sortText: "A_"
                }
                completionItems.push(completionItem);
            }
        }
    }

    return completionItems;
}

connection.onCompletion((position: TextDocumentPositionParams): CompletionItem[] => {
    const text = documents.get(position.textDocument.uri).getText();
    const line = text.split(/\r?\n/g)[position.position.line];
    const char = position.position.character;
    let allCompletionItems: CompletionItem[] = [];

    // Check if the word before the cursor is "case"
    const wordBeforeCursor = getWordBeforeCursor(line, char);
    if (wordBeforeCursor === "case") {
        const caseHandlers = findCaseHandlers(text);
        // Check if the last character in the line is a space
        const lastCharIsSpace = /\s$/.test(line);
        // Modify insertText based on whether the last character is a space or not
        caseHandlers.forEach(item => {
            item.insertText = lastCharIsSpace ? item.label : "case " + item.label;
        });
        allCompletionItems = allCompletionItems.concat(caseHandlers);
    }

    if (pagesPosition(line, char) && pagesHandler) {
        const pageCompletionItems = pagesHandler.getCompletion(line, position.position);
        allCompletionItems = allCompletionItems.concat(pageCompletionItems);
    }
    if (handleSteps() && stepsHandler) {
        const stepsCompletionItems = stepsHandler.getCompletion(line, position.position.line, text);
        allCompletionItems = allCompletionItems.concat(stepsCompletionItems);
    }

    return allCompletionItems;
});

connection.onCompletionResolve((item: CompletionItem): CompletionItem => {
    if (~item.data.indexOf('step')) {
        return stepsHandler.getCompletionResolve(item);
    }
    if (~item.data.indexOf('page')) {
        return pagesHandler.getCompletionResolve(item);
    }
    return item;
});

function validate(text: string): Diagnostic[] {
    return text.split(/\r?\n/g).reduce((res, line, i) => {
        let diagnostic;
        if (handleSteps() && stepsHandler && (diagnostic = stepsHandler.validate(line, i, text))) {
            res.push(diagnostic);
        } else if (handlePages() && pagesHandler) {
            const pagesDiagnosticArr = pagesHandler.validate(line, i);
            res = res.concat(pagesDiagnosticArr);
        }
        return res;
    }, []);
}

documents.onDidChangeContent((change): void => {
    const changeText = change.document.getText();
    //Validate document
    const diagnostics = validate(clearGherkinComments(changeText));
    connection.sendDiagnostics({ uri: change.document.uri, diagnostics });
});

connection.onDefinition((position: TextDocumentPositionParams): Definition => {
    const text = documents.get(position.textDocument.uri).getText();
    const line = text.split(/\r?\n/g)[position.position.line];
    const char = position.position.character;
    const pos = position.position;
    const { uri } = position.textDocument;
    if (pagesPosition(line, char) && pagesHandler) {
        return pagesHandler.getDefinition(line, char);
    }
    if (handleSteps() && stepsHandler) {
        return stepsHandler.getDefinition(line, text);
    }
    return Location.create(uri, Range.create(pos, pos));
});

function getIndent(options: FormattingOptions): string {
    const { insertSpaces, tabSize } = options;
    return insertSpaces ? ' '.repeat(tabSize) : '\t';
}

connection.onDocumentFormatting((params: DocumentFormattingParams): TextEdit[] => {
    const text = documents.get(params.textDocument.uri).getText();
    const textArr = text.split(/\r?\n/g);
    const indent = getIndent(params.options);
    const range = Range.create(Position.create(0, 0), Position.create(textArr.length - 1, textArr[textArr.length - 1].length));
    const formattedText = format(indent, text, settings);
    const clearedText = clearText(formattedText);
    return [TextEdit.replace(range, clearedText)];
});

connection.onDocumentRangeFormatting((params: DocumentRangeFormattingParams): TextEdit[] => {
    const text = documents.get(params.textDocument.uri).getText();
    const textArr = text.split(/\r?\n/g);
    const range = params.range;
    const indent = getIndent(params.options);
    const finalRange = Range.create(Position.create(range.start.line, 0), Position.create(range.end.line, textArr[range.end.line].length));
    const finalText = textArr.splice(finalRange.start.line, finalRange.end.line - finalRange.start.line + 1).join('\r\n');
    const formattedText = format(indent, finalText, settings);
    const clearedText = clearText(formattedText);
    return [TextEdit.replace(finalRange, clearedText)];
});

connection.onDocumentOnTypeFormatting((params: DocumentFormattingParams): TextEdit[] => {
    if (settings.cucumberautocomplete.onTypeFormat === true) {
        const text = documents.get(params.textDocument.uri).getText();
        const textArr = text.split(/\r?\n/g);
        const indent = getIndent(params.options);
        const range = Range.create(Position.create(0, 0), Position.create(textArr.length - 1, textArr[textArr.length - 1].length));
        const formattedText = format(indent, text, settings);
        return [TextEdit.replace(range, formattedText)];
    } else {
        return [];
    };
});

connection.listen();