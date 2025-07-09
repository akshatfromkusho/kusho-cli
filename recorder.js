const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const readline = require('readline');
const https = require('https');
const http = require('http');
const WaitEnhancer = require('./wait-enhancer');

class KushoRecorder {
  constructor() {
    this.outputFile = path.join(__dirname, 'recordings', 'generated-test.js');
    this.recordingDir = path.join(__dirname, 'recordings');
    this.codegenProcess = null;
    this.watcher = null;
    this.onCodeUpdate = null;
    this.currentCode = '';
    this.waitEnhancer = new WaitEnhancer();
    this.enableWaitEnhancement = true;
    this.credentialsFile = path.join(process.env.HOME || process.env.USERPROFILE, '.kusho-credentials');
  }

  async startRecording(url = '', options = {}) {
    // Ensure recordings directory exists
    if (!fs.existsSync(this.recordingDir)) {
      fs.mkdirSync(this.recordingDir, { recursive: true });
    }

    // Clear previous recording
    if (fs.existsSync(this.outputFile)) {
      fs.unlinkSync(this.outputFile);
    }

    console.log(chalk.blue('🎬 Starting KushoAI recorder...'));
    
    const args = [
      'playwright',
      'codegen',
      '--output', this.outputFile,
      '--target', options.target || 'javascript',
      '--viewport-size', options.viewport || '1280,720'
    ];

    // Add device emulation if specified
    if (options.device) {
      args.push('--device', options.device);
    }

    // Add URL if provided
    if (url) {
      args.push(url);
    }

    // Start codegen process
    this.codegenProcess = spawn('npx', args, {
      stdio: 'inherit',
      shell: true
    });

    // Handle process events
    this.codegenProcess.on('error', (error) => {
      console.error(chalk.red('❌ Failed to start recorder:'), error.message);
    });

    this.codegenProcess.on('close', (code) => {
      this.stopWatching();
      this.promptForFilename();
    });

    // Start watching for file changes
    this.watchForChanges();

    return new Promise((resolve) => {
      // Wait a bit for the process to start
      setTimeout(() => {
        console.log(chalk.green('✅ KushoAI recorder started! Interact with the browser to generate code.'));
        resolve();
      }, 2000);
    });
  }

  watchForChanges() {
    // Poll for file existence first
    const checkFile = () => {
      if (fs.existsSync(this.outputFile)) {
        this.startFileWatcher();
      } else {
        setTimeout(checkFile, 500);
      }
    };
    
    checkFile();
  }

  startFileWatcher() {
    
    this.watcher = fs.watch(this.outputFile, (eventType) => {
      if (eventType === 'change') {
        try {
          const newCode = fs.readFileSync(this.outputFile, 'utf8');
          
          // Only process if code actually changed
          if (newCode !== this.currentCode) {
            this.currentCode = newCode;
            this.handleCodeUpdate(newCode);
          }
        } catch (error) {
          // File might be temporarily locked, ignore
        }
      }
    });
  }

  handleCodeUpdate(code) {
    // Enhance code with intelligent waits if enabled
    let finalCode = code;
    if (this.enableWaitEnhancement) {
      finalCode = this.waitEnhancer.enhanceCode(code);
      
      // Show suggestions
      const suggestions = this.waitEnhancer.analyzeAndSuggestWaits(code);
      if (suggestions.length > 0) {
        console.log(chalk.yellow('💡 Suggestions:'));
        suggestions.forEach(s => console.log(chalk.yellow(`  • ${s}`)));
      }
    }
    
    // Wrap code in a test function
    finalCode = this.wrapInTestFunction(finalCode);
    
    console.log(chalk.gray('─'.repeat(50)));
    console.log(finalCode);
    console.log(chalk.gray('─'.repeat(50)));
    
    // Update current code with enhanced version
    this.currentCode = finalCode;
    
    // Call user-defined callback if provided
    if (this.onCodeUpdate) {
      this.onCodeUpdate(finalCode);
    }
  }

  stopRecording() {
    
    if (this.codegenProcess) {
      this.codegenProcess.kill();
      this.codegenProcess = null;
    }
    
    this.stopWatching();
    
    // Return final code
    if (fs.existsSync(this.outputFile)) {
      return fs.readFileSync(this.outputFile, 'utf8');
    }
    
    return this.currentCode;
  }

  stopWatching() {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  getCurrentCode() {
    return this.currentCode;
  }

  saveCodeToFile(filename) {
    const fullPath = path.join(this.recordingDir, filename);
    fs.writeFileSync(fullPath, this.currentCode);
    console.log(chalk.green(`💾 Code saved to: ${fullPath}`));
    return fullPath;
  }

  // Set callback for code updates
  onUpdate(callback) {
    this.onCodeUpdate = callback;
  }

  promptForFilename() {
    if (!this.currentCode || this.currentCode.trim() === '') {
      console.log(chalk.yellow('⚠️  No code to save'));
      return;
    }

    console.log(chalk.green('✅ Recording completed!'));
    
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    rl.question(chalk.cyan('💾 Enter filename for your test (without extension): '), (filename) => {
      rl.close();
      
      if (!filename || filename.trim() === '') {
        // Generate default filename with timestamp
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        filename = `kusho-test-${timestamp}`;
      }

      // Ensure .js extension
      if (!filename.endsWith('.js')) {
        filename += '.js';
      }

      // Save to unique file
      const finalPath = this.saveCodeToUniqueFile(filename);
      console.log(chalk.green(`🎉 Test saved successfully!`));
      console.log(chalk.blue(`📁 File location: ${finalPath}`));
      
      // Open editor for user to edit the file
      this.openEditorInTerminal(finalPath);
    });
  }

  saveCodeToUniqueFile(filename) {
    let counter = 1;
    let baseName = filename.replace('.js', '');
    let finalFilename = filename;
    let fullPath = path.join(this.recordingDir, finalFilename);

    // Check if file exists and create unique name
    while (fs.existsSync(fullPath)) {
      finalFilename = `${baseName}-${counter}.js`;
      fullPath = path.join(this.recordingDir, finalFilename);
      counter++;
    }

    fs.writeFileSync(fullPath, this.currentCode);
    return fullPath;
  }

  openEditorInTerminal(filePath) {
    console.log(chalk.blue('📝 Opening editor...'));
    console.log(chalk.gray('Press Ctrl+X to exit nano, or :wq to exit vim'));
    
    // Try terminal-based editors in order of preference
    const terminalEditors = ['nano', 'vim', 'vi'];
    
    this.tryTerminalEditor(filePath, terminalEditors, 0);
  }

  tryTerminalEditor(filePath, editors, index) {
    if (index >= editors.length) {
      console.log(chalk.yellow('⚠️  No terminal editor found'));
      console.log(chalk.cyan(`📁 You can manually edit: ${filePath}`));
      return;
    }

    const editor = editors[index];
    const editorProcess = spawn(editor, [filePath], { 
      stdio: 'inherit'  // This allows the editor to take control of the terminal
    });

    editorProcess.on('error', (error) => {
      // Try next editor if current one fails
      this.tryTerminalEditor(filePath, editors, index + 1);
    });

    editorProcess.on('close', (code) => {
      if (code === 0) {
        console.log(chalk.green('✅ File edited successfully!'));
        this.extendScriptWithAPI(filePath);
      } else {
        console.log(chalk.yellow('⚠️  Editor exited with errors'));
      }
    });
  }

  async getCredentials() {
    try {
      if (fs.existsSync(this.credentialsFile)) {
        const data = fs.readFileSync(this.credentialsFile, 'utf8');
        return JSON.parse(data);
      }
    } catch (error) {
      console.log(chalk.yellow('⚠️  Error reading credentials file'));
    }
    
    return await this.promptForCredentials();
  }

  async promptForCredentials() {
    console.log(chalk.blue('🔐 KushoAI credentials required for script extension'));
    
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    return new Promise((resolve) => {
      rl.question(chalk.cyan('📧 Enter your email: '), (email) => {
        rl.question(chalk.cyan('🔑 Enter your auth token: '), (token) => {
          rl.close();
          
          const credentials = { email, token };
          
          // Save credentials to file
          try {
            fs.writeFileSync(this.credentialsFile, JSON.stringify(credentials, null, 2));
            console.log(chalk.green('✅ Credentials saved successfully!'));
          } catch (error) {
            console.log(chalk.yellow('⚠️  Warning: Could not save credentials'));
          }
          
          resolve(credentials);
        });
      });
    });
  }

  async extendScriptWithAPI(filePath) {
    console.log(chalk.blue('🚀 Extending script with KushoAI variations...'));
    
    let loadingInterval;
    
    try {
      // Get credentials
      const credentials = await this.getCredentials();
      
      // Read current file content
      const currentContent = fs.readFileSync(filePath, 'utf8');
      
      // Start loading indicator
      loadingInterval = this.showLoadingIndicator();
      
      // Call API
      const extendedScript = await this.callExtendAPI(currentContent, credentials);
      
      // Stop loading indicator
      clearInterval(loadingInterval);
      process.stdout.write('\n');
      
      // Save extended script to same file
      fs.writeFileSync(filePath, extendedScript);
      
      console.log(chalk.green('🎉 Script extended successfully!'));
      console.log(chalk.blue(`📁 Updated file: ${filePath}`));
      
    } catch (error) {
      // Stop loading indicator if still running
      if (loadingInterval) {
        clearInterval(loadingInterval);
        process.stdout.write('\n');
      }
      
      console.log(chalk.red('❌ Error extending script:'), error.message);
      console.log(chalk.blue(`📁 Original file preserved: ${filePath}`));
    }
  }

  showLoadingIndicator() {
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let frameIndex = 0;
    
    return setInterval(() => {
      process.stdout.write(`\r${chalk.blue(frames[frameIndex])} Generating test variations...`);
      frameIndex = (frameIndex + 1) % frames.length;
    }, 100);
  }

  async callExtendAPI(scriptContent, credentials) {
    return new Promise((resolve, reject) => {
      const postData = JSON.stringify({
        script: scriptContent
      });

      const options = {
        hostname: 'localhost', // Replace with actual API hostname
        port: 8080,
        path: '/ui-testing-v2/extend-script',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
          'X-User-Email': credentials.email,
          'X-Auth-Token': credentials.token
        },
        rejectUnauthorized: false // Allow self-signed certificates
      };

      const req = https.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const response = JSON.parse(data);
              resolve(response.extendedScript || response.script || data);
            } catch (error) {
              resolve(data); // Return raw data if not JSON
            }
          } else {
            reject(new Error(`API returned status ${res.statusCode}: ${data}`));
          }
        });
      });

      req.on('error', (error) => {
        reject(error);
      });

      req.write(postData);
      req.end();
    });
  }

  async updateCredentials() {
    console.log(chalk.blue('🔐 Update KushoAI credentials'));
    const credentials = await this.promptForCredentials();
    return credentials;
  }

  wrapInTestFunction(code) {
    // Check if code is already wrapped in a test function
    if (code.includes('test(') || code.includes('describe(')) {
      return code;
    }

    // Extract the main functionality (skip imports and setup)
    const lines = code.split('\n');
    let testStartIndex = 0;
    let imports = '';
    let setup = '';
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('import ') || line.startsWith('const ') || line.startsWith('require(')) {
        imports += lines[i] + '\n';
        testStartIndex = i + 1;
      } else if (line.includes('test =') || line.includes('browser =') || line.includes('context =')) {
        setup += lines[i] + '\n';
        testStartIndex = i + 1;
      } else if (line.length > 0) {
        break;
      }
    }

    const testCode = lines.slice(testStartIndex).join('\n');
    
    // Create wrapped test function
    const wrappedCode = `${imports}
const { test, expect } = require('@playwright/test');

test('KushoAI Generated Test', async ({ page }) => {
${testCode.split('\n').map(line => line.trim() ? '  ' + line : line).join('\n')}
});`;

    return wrappedCode;
  }
}

module.exports = KushoRecorder;