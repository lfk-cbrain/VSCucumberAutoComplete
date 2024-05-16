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
import * as path from 'path';

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
                triggerCharacters: [' ', '.']
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

// Finds case handlers in the background section
// or the scenario where current line (edited line) is.
function findCaseHandlers(featureText, currentLine: number): CompletionItem[] {
    const lines = featureText.split(/\r?\n/);
    const completionItems = [];

    let scenarioStartLine = -1;
    let backgroundStartLine = -1;

    // Find the line numbers where the scenario and background statements start
    for (let i = currentLine; i >= 0; i--) {
        const line = lines[i].trim();
        if (line.startsWith('Scenario:')) {
            scenarioStartLine = i;
            break;
        } else if (line.startsWith('Background:')) {
            backgroundStartLine = i;
        }
    }

    // Find the first scenario line from the beginning of the file
    let firstScenarioLine = -1;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim().startsWith('Scenario:')) {
            firstScenarioLine = i;
            break;
        }
    }

    // If there's only one background statement at the beginning of the file,
    // set its span to extend to just before the first scenario line
    if (backgroundStartLine !== -1 && firstScenarioLine !== -1 && backgroundStartLine < firstScenarioLine) {
        backgroundStartLine = firstScenarioLine - 1;
    }

    // Iterate through lines to find case handlers within the scenario and background
    for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
        const line = lines[lineNumber];
        const trimmedLine = line.trim();

        // Check if the line starts with 'Given case' and is within the scenario or background interval
        if (trimmedLine.startsWith('Given case') && ((scenarioStartLine <= lineNumber && lineNumber <= currentLine) || (backgroundStartLine <= lineNumber && lineNumber <= firstScenarioLine))) {
            // Match lines starting with 'Given case' followed by a case handler name
            const caseHandlerMatch = trimmedLine.match(/^Given case (\S+)(?: with taskguide (\S+)| is (\S+))?/);
            if (caseHandlerMatch) {
                const caseHandler = caseHandlerMatch[1];
                let taskGuideType: string;
                caseHandlerMatch[2] !== undefined ? taskGuideType = caseHandlerMatch[2] : taskGuideType = caseHandlerMatch[3]

                const completionItem = {
                    label: caseHandler,
                    kind: CompletionItemKind.Variable,
                    detail: `Taskguide: ${taskGuideType}`,
                    sortText: "A_",
                    data: ""
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
    const wordBeforeCursor = getWordBeforeCursor(line, char);
    const caseHandlers = findCaseHandlers(text, position.position.line);

    let allCompletionItems: CompletionItem[] = [];

    if (wordBeforeCursor === "case" || wordBeforeCursor === "field") {
        allCompletionItems = addCaseHandlersToCompletionItems(line, caseHandlers, allCompletionItems);
    }

    allCompletionItems = extractFieldsForCaseHandlerIfPossible(caseHandlers, wordBeforeCursor, allCompletionItems);

    if (pagesPosition(line, char) && pagesHandler) {
        allCompletionItems = allCompletionItems.concat(pagesHandler.getCompletion(line, position.position));
    }
    if (handleSteps() && stepsHandler) {
        allCompletionItems = allCompletionItems.concat(stepsHandler.getCompletion(line, position.position.line, text));
    }
    

    return allCompletionItems;
});

connection.onCompletionResolve((item: CompletionItem): CompletionItem => {
    if (item.data) {
        if (~item.data.indexOf('step')) {
            return stepsHandler.getCompletionResolve(item);
        }
        if (~item.data.indexOf('page')) {
            return pagesHandler.getCompletionResolve(item);
        }
    }
    return item;
});

function extractFieldsForCaseHandlerIfPossible(caseHandlers: CompletionItem[], wordBeforeCursor: string, allCompletionItems: CompletionItem[]) {
    const caseHandlerBeforeCursor = caseHandlers.filter(handler => `${handler.label}.` === wordBeforeCursor);

    if (caseHandlerBeforeCursor.length > 0 && caseHandlerBeforeCursor[0].detail != null) {
        const caseHandler = caseHandlerBeforeCursor[0];
        const fileName = caseHandler.detail.split(" ")[1];

        const taskGuidesFolder = path.join(workspaceRoot, 'Data', 'TaskGuides');
        const fallbackTaskGuidesFolder = path.join(workspaceRoot, 'TaskGuides');
        const taskGuidesPath = fs.existsSync(taskGuidesFolder) ? taskGuidesFolder : fallbackTaskGuidesFolder;

        // Find the directory that matches with the filename (casehandler taskguide) 
        // and then find the fields file.
        fs.readdirSync(taskGuidesPath).forEach(dir => {
            if (dir.toLowerCase() === fileName.toLowerCase()) {
                const foundTaskGuideFolder = path.join(taskGuidesPath, dir);
                fs.readdirSync(foundTaskGuideFolder).forEach(file => {
                    if (file.startsWith(fileName) && /\.fields\.xml$/.test(file)) {
                        const filePath = path.join(foundTaskGuideFolder, file);
                        try {
                            const fileContents = fs.readFileSync(filePath, 'utf8');
                            const completionItemsFromXml = parseXmlForCompletionItems(fileContents);
                            allCompletionItems = allCompletionItems.concat(completionItemsFromXml);
                            return allCompletionItems
                        } catch (error) {
                            console.error(`Error reading or parsing file: ${file}`);
                            console.error(error);
                        }
                    }
                });
            }
        });
    }
    return allCompletionItems;
}

function parseXmlForCompletionItems(xmlContent: string): CompletionItem[] {
    const completionItems: CompletionItem[] = [];

    const nameAttributeRegex = /Name="([^"]+)"/;
    const typeAttributeRegex = /Type="([^"]+)"/;
    const TitleAttributeRegex = /Title="([^"]+)"/;

    const lines = xmlContent.split(/\r?\n/);

    for (const line of lines) {
        const nameMatch = nameAttributeRegex.exec(line);
        const typeMatch = typeAttributeRegex.exec(line);
        const titleMatch = TitleAttributeRegex.exec(line);

        let typeText: string = "";
        let detailText: string = "";

        if (typeMatch) {
            typeText = typeMatch[1];
            detailText += `Type: "${typeText}" \n`
        }

        if (titleMatch) {
            detailText += `Title: "${titleMatch[1]}"`
        }

        if (nameMatch) {
            completionItems.push({
                label: nameMatch[1],
                detail: typeText,
                documentation: detailText,
                kind: CompletionItemKind.Variable,
                sortText: "AA_",
                data: "",
            });
        }
    }
    return completionItems;
}

function addCaseHandlersToCompletionItems(line: string, caseHandlers: CompletionItem[], allCompletionItems: CompletionItem[]) {
    const lastCharIsSpace = /\s$/.test(line);
    caseHandlers.forEach(item => {
        item.insertText = lastCharIsSpace ? item.label : "case " + item.label;
    });

    allCompletionItems = allCompletionItems.concat(caseHandlers);
    return allCompletionItems;
}

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