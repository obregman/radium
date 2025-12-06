import * as assert from 'assert';
import { SemanticAnalyzer } from '../../src/analysis/semantic-analyzer';

suite('XAML.CS Function Detection Tests', () => {
  let analyzer: SemanticAnalyzer;

  setup(() => {
    analyzer = new SemanticAnalyzer();
  });

  suite('Typical XAML.CS Method Patterns', () => {
    test('should detect private void event handler', () => {
      const diff = `
@@ -0,0 +1,4 @@
+private void OnButtonClick(object sender, EventArgs e)
+{
+    MessageBox.Show("Clicked!");
+}`;

      const changes = analyzer.analyzeDiff('MainWindow.xaml.cs', diff);
      
      const addFunctionChanges = changes.filter(c => c.category === 'add_function');
      assert.ok(addFunctionChanges.length >= 1, `Should detect function addition, got ${changes.length} changes: ${JSON.stringify(changes.map(c => c.category))}`);
      
      if (addFunctionChanges.length > 0) {
        assert.ok(
          addFunctionChanges[0].description.includes('OnButtonClick'),
          `Should include function name, got: ${addFunctionChanges[0].description}`
        );
      }
    });

    test('should detect public async void method', () => {
      const diff = `
@@ -0,0 +1,4 @@
+public async void LoadDataAsync()
+{
+    await Task.Delay(100);
+}`;

      const changes = analyzer.analyzeDiff('MainWindow.xaml.cs', diff);
      
      const addFunctionChanges = changes.filter(c => c.category === 'add_function');
      assert.ok(addFunctionChanges.length >= 1, `Should detect async void method, got ${changes.length} changes: ${JSON.stringify(changes.map(c => c.category))}`);
      
      if (addFunctionChanges.length > 0) {
        assert.ok(
          addFunctionChanges[0].description.includes('LoadDataAsync'),
          `Should include function name, got: ${addFunctionChanges[0].description}`
        );
      }
    });

    test('should detect private async Task method', () => {
      const diff = `
@@ -0,0 +1,4 @@
+private async Task<User> GetUserAsync(int id)
+{
+    return await _service.GetUserAsync(id);
+}`;

      const changes = analyzer.analyzeDiff('UserControl.xaml.cs', diff);
      
      const addFunctionChanges = changes.filter(c => c.category === 'add_function');
      assert.ok(addFunctionChanges.length >= 1, `Should detect async Task method, got ${changes.length} changes: ${JSON.stringify(changes.map(c => c.category))}`);
      
      if (addFunctionChanges.length > 0) {
        assert.ok(
          addFunctionChanges[0].description.includes('GetUserAsync'),
          `Should include function name, got: ${addFunctionChanges[0].description}`
        );
      }
    });

    test('should detect protected virtual void method', () => {
      const diff = `
@@ -0,0 +1,4 @@
+protected virtual void OnPropertyChanged(string propertyName)
+{
+    PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(propertyName));
+}`;

      const changes = analyzer.analyzeDiff('BaseControl.xaml.cs', diff);
      
      const addFunctionChanges = changes.filter(c => c.category === 'add_function');
      assert.ok(addFunctionChanges.length >= 1, `Should detect virtual method, got ${changes.length} changes: ${JSON.stringify(changes.map(c => c.category))}`);
      
      if (addFunctionChanges.length > 0) {
        assert.ok(
          addFunctionChanges[0].description.includes('OnPropertyChanged'),
          `Should include function name, got: ${addFunctionChanges[0].description}`
        );
      }
    });

    test('should detect public override void method', () => {
      const diff = `
@@ -0,0 +1,4 @@
+public override void OnApplyTemplate()
+{
+    base.OnApplyTemplate();
+}`;

      const changes = analyzer.analyzeDiff('CustomControl.xaml.cs', diff);
      
      const addFunctionChanges = changes.filter(c => c.category === 'add_function');
      assert.ok(addFunctionChanges.length >= 1, `Should detect override method, got ${changes.length} changes: ${JSON.stringify(changes.map(c => c.category))}`);
      
      if (addFunctionChanges.length > 0) {
        assert.ok(
          addFunctionChanges[0].description.includes('OnApplyTemplate'),
          `Should include function name, got: ${addFunctionChanges[0].description}`
        );
      }
    });

    test('should detect internal static void method', () => {
      const diff = `
@@ -0,0 +1,4 @@
+internal static void RegisterDependencyProperty()
+{
+    // Registration code
+}`;

      const changes = analyzer.analyzeDiff('Helper.xaml.cs', diff);
      
      const addFunctionChanges = changes.filter(c => c.category === 'add_function');
      assert.ok(addFunctionChanges.length >= 1, `Should detect static method, got ${changes.length} changes: ${JSON.stringify(changes.map(c => c.category))}`);
      
      if (addFunctionChanges.length > 0) {
        assert.ok(
          addFunctionChanges[0].description.includes('RegisterDependencyProperty'),
          `Should include function name, got: ${addFunctionChanges[0].description}`
        );
      }
    });

    test('should detect public async Task<T> method with generic', () => {
      const diff = `
@@ -0,0 +1,4 @@
+public async Task<List<Item>> GetItemsAsync()
+{
+    return await _repository.GetAllAsync();
+}`;

      const changes = analyzer.analyzeDiff('DataControl.xaml.cs', diff);
      
      const addFunctionChanges = changes.filter(c => c.category === 'add_function');
      assert.ok(addFunctionChanges.length >= 1, `Should detect async Task<T> method, got ${changes.length} changes: ${JSON.stringify(changes.map(c => c.category))}`);
      
      if (addFunctionChanges.length > 0) {
        assert.ok(
          addFunctionChanges[0].description.includes('GetItemsAsync'),
          `Should include function name, got: ${addFunctionChanges[0].description}`
        );
      }
    });
  });

  suite('Method Deletions in XAML.CS', () => {
    test('should detect deleted private void event handler', () => {
      const diff = `
@@ -10,4 +10,0 @@
-private void OnButtonClick(object sender, EventArgs e)
-{
-    MessageBox.Show("Clicked!");
-}`;

      const changes = analyzer.analyzeDiff('MainWindow.xaml.cs', diff);
      
      const deleteFunctionChanges = changes.filter(c => c.category === 'delete_function');
      assert.ok(deleteFunctionChanges.length >= 1, `Should detect function deletion, got ${changes.length} changes: ${JSON.stringify(changes.map(c => c.category))}`);
      
      if (deleteFunctionChanges.length > 0) {
        assert.ok(
          deleteFunctionChanges[0].description.includes('OnButtonClick'),
          `Should include function name, got: ${deleteFunctionChanges[0].description}`
        );
      }
    });

    test('should detect deleted public async void method', () => {
      const diff = `
@@ -15,4 +15,0 @@
-public async void LoadDataAsync()
-{
-    await Task.Delay(100);
-}`;

      const changes = analyzer.analyzeDiff('MainWindow.xaml.cs', diff);
      
      const deleteFunctionChanges = changes.filter(c => c.category === 'delete_function');
      assert.ok(deleteFunctionChanges.length >= 1, `Should detect async method deletion, got ${changes.length} changes: ${JSON.stringify(changes.map(c => c.category))}`);
      
      if (deleteFunctionChanges.length > 0) {
        assert.ok(
          deleteFunctionChanges[0].description.includes('LoadDataAsync'),
          `Should include function name, got: ${deleteFunctionChanges[0].description}`
        );
      }
    });
  });

  suite('Edge Cases in XAML.CS', () => {
    test('should handle method with multiple parameters', () => {
      const diff = `
@@ -0,0 +1,4 @@
+private void UpdateUI(string title, int count, bool isEnabled)
+{
+    Title = title;
+}`;

      const changes = analyzer.analyzeDiff('MainWindow.xaml.cs', diff);
      
      const addFunctionChanges = changes.filter(c => c.category === 'add_function');
      assert.ok(addFunctionChanges.length >= 1, `Should detect method with multiple params, got ${changes.length} changes`);
    });

    test('should handle method with lambda in body', () => {
      const diff = `
@@ -0,0 +1,4 @@
+private void InitializeHandlers()
+{
+    button.Click += (s, e) => MessageBox.Show("Clicked");
+}`;

      const changes = analyzer.analyzeDiff('MainWindow.xaml.cs', diff);
      
      const addFunctionChanges = changes.filter(c => c.category === 'add_function');
      assert.ok(addFunctionChanges.length >= 1, `Should detect method with lambda, got ${changes.length} changes`);
    });

    test('should handle indented method (inside class)', () => {
      const diff = `
@@ -10,0 +11,4 @@ public partial class MainWindow
+    private void OnLoad(object sender, EventArgs e)
+    {
+        InitializeComponent();
+    }`;

      const changes = analyzer.analyzeDiff('MainWindow.xaml.cs', diff);
      
      const addFunctionChanges = changes.filter(c => c.category === 'add_function');
      assert.ok(addFunctionChanges.length >= 1, `Should detect indented method, got ${changes.length} changes: ${JSON.stringify(changes.map(c => c.category))}`);
    });
  });

  suite('Real-world XAML.CS Scenarios', () => {
    test('should detect typical WPF event handler pattern', () => {
      const diff = `
@@ -20,0 +21,7 @@ public partial class GameWindow : Window
+    private void StartButton_Click(object sender, RoutedEventArgs e)
+    {
+        gameEngine.Start();
+        StartButton.IsEnabled = false;
+        StopButton.IsEnabled = true;
+        statusLabel.Content = "Game Running";
+    }`;

      const changes = analyzer.analyzeDiff('GameWindow.xaml.cs', diff);
      
      const addFunctionChanges = changes.filter(c => c.category === 'add_function');
      assert.ok(addFunctionChanges.length >= 1, `Should detect WPF event handler, got ${changes.length} changes: ${JSON.stringify(changes.map(c => c.category))}`);
      
      if (addFunctionChanges.length > 0) {
        assert.ok(
          addFunctionChanges[0].description.includes('StartButton_Click'),
          `Should include handler name, got: ${addFunctionChanges[0].description}`
        );
      }
    });

    test('should detect async data loading method', () => {
      const diff = `
@@ -30,0 +31,8 @@ public partial class DataGrid : UserControl
+    private async Task LoadDataAsync()
+    {
+        LoadingIndicator.Visibility = Visibility.Visible;
+        var data = await _dataService.GetDataAsync();
+        DataGrid.ItemsSource = data;
+        LoadingIndicator.Visibility = Visibility.Collapsed;
+    }`;

      const changes = analyzer.analyzeDiff('DataGrid.xaml.cs', diff);
      
      const addFunctionChanges = changes.filter(c => c.category === 'add_function');
      assert.ok(addFunctionChanges.length >= 1, `Should detect async loading method, got ${changes.length} changes: ${JSON.stringify(changes.map(c => c.category))}`);
      
      if (addFunctionChanges.length > 0) {
        assert.ok(
          addFunctionChanges[0].description.includes('LoadDataAsync'),
          `Should include method name, got: ${addFunctionChanges[0].description}`
        );
      }
    });
  });
});

