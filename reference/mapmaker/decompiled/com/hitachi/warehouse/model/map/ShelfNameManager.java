/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.model.map;

import common.io.LineReader;
import common.util.StringList;
import java.awt.BorderLayout;
import java.awt.Component;
import java.awt.Dimension;
import java.awt.event.ActionEvent;
import java.awt.event.ActionListener;
import java.io.File;
import java.io.PrintWriter;
import java.io.Serializable;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import javax.swing.JButton;
import javax.swing.JFrame;
import javax.swing.JOptionPane;
import javax.swing.JScrollPane;
import javax.swing.JTextArea;

public class ShelfNameManager
implements Serializable {
    private static final long serialVersionUID = -8701014311820674820L;
    List<String> names = new ArrayList<String>();
    transient ShelfNameEditor editor = null;

    public List<String> names() {
        return this.names;
    }

    /*
     * Enabled aggressive exception aggregation
     */
    public boolean loadFromFile(File f2) {
        if (f2 != null && f2.exists()) {
            try {
                ArrayList<String> names = new ArrayList<String>();
                names.clear();
                for (String line : LineReader.readLines(f2)) {
                    if ((line = line.trim()).length() <= 0) continue;
                    names.add(line);
                }
                int cnt1 = 0;
                while (cnt1 < names.size()) {
                    int cnt2 = 0;
                    while (cnt2 < names.size()) {
                        if (cnt1 != cnt2 && names.get(cnt1).equals(names.get(cnt2))) {
                            JOptionPane.showMessageDialog(null, "棚名が重複しています。ファイルを修正して下さい。", "エラー", 0);
                            return false;
                        }
                        ++cnt2;
                    }
                    ++cnt1;
                }
                this.setNames(names);
                if (this.editor != null) {
                    this.editor.reload();
                }
                return true;
            }
            catch (Exception e) {
                e.printStackTrace();
                return false;
            }
        }
        return false;
    }

    /*
     * WARNING - Removed try catching itself - possible behaviour change.
     */
    public void setNames(Collection<String> names) {
        Collection<String> collection = names;
        synchronized (collection) {
            this.names.clear();
            this.names.addAll(names);
        }
    }

    /*
     * WARNING - Removed try catching itself - possible behaviour change.
     */
    public void save(File f2) {
        if (f2 != null) {
            List<String> list = this.names;
            synchronized (list) {
                try {
                    PrintWriter out = new PrintWriter(f2);
                    for (String name : this.names) {
                        out.println(name);
                    }
                    out.close();
                }
                catch (Exception e) {
                    e.printStackTrace();
                }
            }
        }
    }

    /*
     * WARNING - Removed try catching itself - possible behaviour change.
     */
    public String nameAtIdx(int idx) {
        List<String> list = this.names;
        synchronized (list) {
            if (idx >= 0 && idx < this.names.size()) {
                return this.names.get(idx);
            }
        }
        return "";
    }

    public int idxForName(String name) {
        return this.names.indexOf(name);
    }

    /*
     * WARNING - Removed try catching itself - possible behaviour change.
     */
    public String nameAfterName(String name) {
        List<String> list = this.names;
        synchronized (list) {
            int idx = this.names.indexOf(name);
            return this.nameAtIdx(idx + 1);
        }
    }

    public void openEditor() {
        if (this.editor == null) {
            this.editor = new ShelfNameEditor(this);
        }
        this.editor.setVisible(true);
        this.editor.reload();
    }

    public void closeEditor() {
        if (this.editor != null) {
            this.editor.setVisible(false);
        }
    }

    public boolean isVisibleEditor() {
        if (this.editor == null) {
            return false;
        }
        return this.editor.isVisible();
    }

    public static void main(String[] args) {
        File f2 = new File("shelfNames.csv");
        ShelfNameManager shelfNameManager = new ShelfNameManager();
        shelfNameManager.loadFromFile(f2);
        for (String name : shelfNameManager.names()) {
            System.out.println(String.valueOf(name) + " " + shelfNameManager.nameAfterName(name));
        }
        shelfNameManager.openEditor();
    }

    public static class ShelfNameEditor
    extends JFrame {
        final ShelfNameManager manager;
        final JTextArea txtArea;

        public ShelfNameEditor(final ShelfNameManager manager) {
            this.manager = manager;
            this.setLayout(new BorderLayout());
            this.txtArea = new JTextArea();
            JScrollPane pnlTxtArea = new JScrollPane(this.txtArea);
            pnlTxtArea.setPreferredSize(new Dimension(200, 400));
            this.add((Component)pnlTxtArea, "Center");
            JButton btnSave = new JButton("Save");
            btnSave.addActionListener(new ActionListener(){

                @Override
                public void actionPerformed(ActionEvent arg0) {
                    ArrayList<String> names = new ArrayList<String>();
                    String[] stringArray = ShelfNameEditor.this.txtArea.getText().split("\n");
                    int n = stringArray.length;
                    int n2 = 0;
                    while (n2 < n) {
                        String line = stringArray[n2];
                        if ((line = line.trim()).length() > 0) {
                            names.add(line);
                        }
                        ++n2;
                    }
                    int cnt1 = 0;
                    while (cnt1 < names.size()) {
                        int cnt2 = 0;
                        while (cnt2 < names.size()) {
                            if (cnt1 != cnt2 && names.get(cnt1).equals(names.get(cnt2))) {
                                JOptionPane.showMessageDialog(null, "棚名が重複しています。", "エラー", 0);
                                return;
                            }
                            ++cnt2;
                        }
                        ++cnt1;
                    }
                    manager.setNames(names);
                    ShelfNameEditor.this.setVisible(false);
                }
            });
            this.add((Component)btnSave, "South");
            this.pack();
            this.setVisible(true);
        }

        public void reload() {
            StringList buf = new StringList("\n");
            for (String name : this.manager.names) {
                buf.add((Object)name);
            }
            this.txtArea.setText(buf.toString());
        }
    }
}

