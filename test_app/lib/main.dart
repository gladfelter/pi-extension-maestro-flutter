import "package:flutter/material.dart";

void main() {
  runApp(const TestApp());
}

class TestApp extends StatelessWidget {
  const TestApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: "Pi Extension Test App",
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorSchemeSeed: Colors.blue,
        useMaterial3: true,
      ),
      home: const HomeScreen(),
    );
  }
}

// ─── Home Screen ────────────────────────────────────────────────────────────
// Exposes: labeled buttons for tap testing, counter for state changes,
// navigation to other screens.
class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  int _counter = 0;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text("Pi Test App"),
        backgroundColor: Theme.of(context).colorScheme.inversePrimary,
      ),
      body: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            // Counter section — tests state mutation via tap
            Semantics(
              label: "counter-display",
              child: Text(
                "Count: $_counter",
                style: Theme.of(context).textTheme.headlineMedium,
              ),
            ),
            const SizedBox(height: 16),
            Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Semantics(
                  label: "increment-button",
                  child: ElevatedButton(
                    onPressed: () => setState(() => _counter++),
                    child: const Text("+ Increment"),
                  ),
                ),
                const SizedBox(width: 12),
                Semantics(
                  label: "decrement-button",
                  child: ElevatedButton(
                    onPressed: () => setState(() => _counter--),
                    child: const Text("- Decrement"),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 32),
            // Navigation buttons — each has a Semantics label for Maestro
            Semantics(
              label: "nav-to-form",
              child: ElevatedButton.icon(
                onPressed: () => Navigator.push(
                  context,
                  MaterialPageRoute(builder: (_) => const FormScreen()),
                ),
                icon: const Icon(Icons.edit),
                label: const Text("Open Form Screen"),
              ),
            ),
            const SizedBox(height: 12),
            Semantics(
              label: "nav-to-list",
              child: ElevatedButton.icon(
                onPressed: () => Navigator.push(
                  context,
                  MaterialPageRoute(builder: (_) => const ListScreen()),
                ),
                icon: const Icon(Icons.list),
                label: const Text("Open List Screen"),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// ─── Form Screen ────────────────────────────────────────────────────────────
// Exposes: text input fields with labels, submit button, result display.
// Maestro can inputText, tapOn submit, and read the result text.
class FormScreen extends StatefulWidget {
  const FormScreen({super.key});

  @override
  State<FormScreen> createState() => _FormScreenState();
}

class _FormScreenState extends State<FormScreen> {
  final _nameController = TextEditingController();
  final _emailController = TextEditingController();
  String? _result;

  @override
  void dispose() {
    _nameController.dispose();
    _emailController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text("Form Screen"),
        backgroundColor: Theme.of(context).colorScheme.inversePrimary,
      ),
      body: Padding(
        padding: const EdgeInsets.all(24.0),
        child: Column(
          children: [
            Semantics(
              identifier: "name-field",
              child: TextField(
                controller: _nameController,
                decoration: const InputDecoration(
                  labelText: "Name",
                  border: OutlineInputBorder(),
                ),
              ),
            ),
            const SizedBox(height: 16),
            Semantics(
              identifier: "email-field",
              child: TextField(
                controller: _emailController,
                decoration: const InputDecoration(
                  labelText: "Email",
                  border: OutlineInputBorder(),
                ),
                keyboardType: TextInputType.emailAddress,
              ),
            ),
            const SizedBox(height: 16),
            Semantics(
              identifier: "submit-button",
              child: ElevatedButton(
                onPressed: () {
                  setState(() {
                    _result =
                        "Submitted: ${_nameController.text} <${_emailController.text}>";
                  });
                },
                child: const Text("Submit"),
              ),
            ),
            const SizedBox(height: 24),
            if (_result != null)
              Semantics(
                label: "result-text",
                child: Text(
                  _result!,
                  style: Theme.of(context).textTheme.bodyLarge,
                ),
              ),
          ],
        ),
      ),
    );
  }
}

// ─── List Screen ────────────────────────────────────────────────────────────
// Exposes: scrollable list with labeled items for scroll / tap testing.
class ListScreen extends StatelessWidget {
  const ListScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text("List Screen"),
        backgroundColor: Theme.of(context).colorScheme.inversePrimary,
      ),
      body: ListView.builder(
        itemCount: 100,
        itemBuilder: (context, index) {
          return Semantics(
            label: "list-item-$index",
            child: ListTile(
              leading: CircleAvatar(child: Text("${index + 1}")),
              title: Text("Item ${index + 1}"),
              subtitle: Text("This is list item number ${index + 1}."),
              onTap: () {
                ScaffoldMessenger.of(context).showSnackBar(
                  SnackBar(content: Text("Tapped item ${index + 1}")),
                );
              },
            ),
          );
        },
      ),
    );
  }
}
