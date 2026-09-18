/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.mapmaker.commands;

import com.hitachi.warehouse.gui.mapframe.AbstractMapPanel;
import com.hitachi.warehouse.mapmaker.MapMaker;
import com.hitachi.warehouse.model.map.WorldMap;
import com.hitachi.warehouse.model.map.objects.AbstractObject;
import com.hitachi.warehouse.model.map.objects.FreeShelfObject;
import java.awt.BorderLayout;
import java.awt.Color;
import java.awt.Component;
import java.awt.Dimension;
import java.awt.Graphics2D;
import java.awt.event.ItemEvent;
import java.awt.event.ItemListener;
import java.awt.event.WindowAdapter;
import java.awt.event.WindowEvent;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Vector;
import javax.swing.ButtonGroup;
import javax.swing.JFrame;
import javax.swing.JLabel;
import javax.swing.JPanel;
import javax.swing.JRadioButton;
import javax.swing.JScrollPane;
import javax.swing.JTable;
import javax.swing.JTextField;
import javax.swing.RowFilter;
import javax.swing.RowSorter;
import javax.swing.SortOrder;
import javax.swing.event.DocumentEvent;
import javax.swing.event.DocumentListener;
import javax.swing.event.ListSelectionEvent;
import javax.swing.event.ListSelectionListener;
import javax.swing.event.RowSorterEvent;
import javax.swing.event.RowSorterListener;
import javax.swing.table.DefaultTableModel;
import javax.swing.table.JTableHeader;
import javax.swing.table.TableModel;
import javax.swing.table.TableRowSorter;

public class ShelfSearchManager {
    private MapMaker mapMaker;
    private ShelfSearchFrame frame = null;
    private ShelfSearchPanel panel = null;

    public ShelfSearchManager(MapMaker mapMaker) {
        this.mapMaker = mapMaker;
    }

    public void open() {
        if (this.panel == null) {
            this.panel = new ShelfSearchPanel(this);
            this.mapMaker.mapFrame.mapView.openChildView(this.panel);
        }
        if (this.frame == null) {
            this.frame = new ShelfSearchFrame(this);
            this.frame.addWindowListener(new WindowAdapter(){

                @Override
                public void windowClosing(WindowEvent e) {
                    ((ShelfSearchManager)ShelfSearchManager.this).mapMaker.mapFrame.mapView.closeChildview(ShelfSearchManager.this.panel);
                    ShelfSearchManager.this.frame.destroy();
                    super.windowClosing(e);
                    ShelfSearchManager.this.panel = null;
                    ShelfSearchManager.this.frame = null;
                }
            });
        }
        this.frame.setLocationRelativeTo(this.mapMaker.mapFrame);
        this.frame.setVisible(true);
    }

    public static class ShelfSearchFrame
    extends JFrame {
        final ShelfSearchManager manager;
        final Map<Integer, FreeShelfObject> allShelfObjects = new HashMap<Integer, FreeShelfObject>();
        final List<FreeShelfObject> highlightShelfObjects = new ArrayList<FreeShelfObject>();
        final DefaultTableModel model = new DefaultTableModel();
        final JTable shelfTbl = new JTable(this.model){

            @Override
            public boolean isCellEditable(int row, int column) {
                return false;
            }
        };
        final JTextField filterTextField;
        final TableRowSorter<TableModel> sorter = new TableRowSorter();
        private ArrayList<RowSorter.SortKey> sortKeys = new ArrayList();
        private List<WorldMap.WorldMapChangedListener> worldMapChangedListeners = new ArrayList<WorldMap.WorldMapChangedListener>();
        final JRadioButton chkShelfNameIsSpace;
        final JRadioButton chkShelfNameIsDuplicate;
        final JRadioButton chkSerchShelfName;

        public ShelfSearchFrame(ShelfSearchManager manager) {
            Collections.unmodifiableList(this.sortKeys);
            this.sortKeys.add(new RowSorter.SortKey(1, SortOrder.ASCENDING));
            this.sortKeys.add(new RowSorter.SortKey(0, SortOrder.ASCENDING));
            this.manager = manager;
            this.setTitle("ShelfSearch");
            this.setLayout(new BorderLayout());
            this.setTableRows(manager.mapMaker.map());
            this.shelfTbl.setSelectionMode(2);
            this.shelfTbl.getSelectionModel().addListSelectionListener(new ListSelectionListener(){

                @Override
                public void valueChanged(ListSelectionEvent e) {
                    if (e.getValueIsAdjusting()) {
                        return;
                    }
                    this.selectHighlightShelfObjects(this.getSelectedKeys());
                }
            });
            JScrollPane pnlShelfTblArea = new JScrollPane(this.shelfTbl);
            pnlShelfTblArea.setPreferredSize(new Dimension(280, 400));
            this.add((Component)pnlShelfTblArea, "Center");
            JPanel pnlShelfConditionsArea = new JPanel();
            pnlShelfConditionsArea.setLayout(null);
            pnlShelfConditionsArea.setPreferredSize(new Dimension(pnlShelfTblArea.getWidth(), 130));
            JLabel lblTitle = new JLabel("■棚名検索");
            lblTitle.setBounds(5, 1, 250, 25);
            pnlShelfConditionsArea.add(lblTitle);
            this.chkShelfNameIsSpace = new JRadioButton("空白棚名の表示");
            this.chkShelfNameIsSpace.setBounds(15, 25, 250, 25);
            pnlShelfConditionsArea.add(this.chkShelfNameIsSpace);
            this.chkShelfNameIsDuplicate = new JRadioButton("重複棚名の表示（空白棚名除く）");
            this.chkShelfNameIsDuplicate.setBounds(15, 50, 250, 25);
            pnlShelfConditionsArea.add(this.chkShelfNameIsDuplicate);
            this.chkSerchShelfName = new JRadioButton("棚名の指定検索");
            this.chkSerchShelfName.setBounds(15, 75, 250, 25);
            pnlShelfConditionsArea.add(this.chkSerchShelfName);
            this.chkSerchShelfName.setSelected(true);
            ButtonGroup grpSearchCondition = new ButtonGroup();
            grpSearchCondition.add(this.chkShelfNameIsDuplicate);
            grpSearchCondition.add(this.chkShelfNameIsSpace);
            grpSearchCondition.add(this.chkSerchShelfName);
            this.filterTextField = new JTextField();
            this.filterTextField.setBounds(35, 100, 220, 25);
            pnlShelfConditionsArea.add(this.filterTextField);
            this.add((Component)pnlShelfConditionsArea, "North");
            final HashSet<3> filters = new HashSet<3>();
            RowFilter<TableModel, Integer> textFilter = new RowFilter<TableModel, Integer>(){

                @Override
                public boolean include(RowFilter.Entry<? extends TableModel, ? extends Integer> entry) {
                    if (chkShelfNameIsSpace.isSelected()) {
                        TableModel model = entry.getModel();
                        String name = String.valueOf(model.getValueAt(entry.getIdentifier(), 1));
                        return name.length() == 0;
                    }
                    if (chkShelfNameIsDuplicate.isSelected()) {
                        TableModel model = entry.getModel();
                        String name = String.valueOf(model.getValueAt(entry.getIdentifier(), 1));
                        int cnt = 0;
                        while (cnt < model.getRowCount()) {
                            if (name.length() != 0 && name.equals(model.getValueAt(cnt, 1).toString()) && entry.getIdentifier() != cnt) {
                                return true;
                            }
                            ++cnt;
                        }
                        return false;
                    }
                    if (filterTextField.getText().length() == 0) {
                        return true;
                    }
                    TableModel model = entry.getModel();
                    String name = String.valueOf(model.getValueAt(entry.getIdentifier(), 1));
                    return name.indexOf(filterTextField.getText()) > -1;
                }
            };
            filters.add(textFilter);
            this.sorter.setModel(this.shelfTbl.getModel());
            this.sorter.setRowFilter(RowFilter.andFilter(filters));
            this.shelfTbl.setRowSorter(this.sorter);
            this.shelfTbl.selectAll();
            this.sorter.setSortKeys(this.sortKeys);
            this.sorter.addRowSorterListener(new RowSorterListener(){

                @Override
                public void sorterChanged(RowSorterEvent e) {
                    Object source = e.getSource();
                    TableModel model = (TableModel)((RowSorter)e.getSource()).getModel();
                    int[] selectedKeys = new int[((RowSorter)source).getViewRowCount()];
                    int i = 0;
                    while (i < ((RowSorter)source).getViewRowCount()) {
                        int modelRowIndex = ((RowSorter)source).convertRowIndexToModel(i);
                        selectedKeys[i] = Integer.valueOf(String.valueOf(model.getValueAt(modelRowIndex, 0)));
                        ++i;
                    }
                    this.selectHighlightShelfObjects(selectedKeys);
                }
            });
            this.filterTextField.getDocument().addDocumentListener(new DocumentListener(){

                @Override
                public void removeUpdate(DocumentEvent e) {
                    this.filtering(e);
                }

                @Override
                public void insertUpdate(DocumentEvent e) {
                    this.filtering(e);
                }

                @Override
                public void changedUpdate(DocumentEvent e) {
                    this.filtering(e);
                }

                private void filtering(DocumentEvent e) {
                    sorter.setRowFilter(RowFilter.andFilter(filters));
                    sorter.setSortKeys(sortKeys);
                    shelfTbl.selectAll();
                }
            });
            this.chkShelfNameIsSpace.addItemListener(new ItemListener(){

                @Override
                public void itemStateChanged(ItemEvent e) {
                    this.SearchConditionChange(filters);
                }
            });
            this.chkShelfNameIsDuplicate.addItemListener(new ItemListener(){

                @Override
                public void itemStateChanged(ItemEvent e) {
                    this.SearchConditionChange(filters);
                }
            });
            this.sorter.setSortKeys(this.sortKeys);
            this.chkSerchShelfName.addItemListener(new ItemListener(){

                @Override
                public void itemStateChanged(ItemEvent e) {
                    this.SearchConditionChange(filters);
                }
            });
            this.pack();
            this.setVisible(true);
            this.filterTextField.requestFocus();
            this.worldMapChangedListeners.add(new WorldMap.WorldMapChangedListener(){

                @Override
                public void mapChanged(WorldMap map) {
                    this.setTableRows(map);
                    shelfTbl.selectAll();
                    sorter.setSortKeys(sortKeys);
                    int[] selectedKeys = this.getSelectedKeys();
                    this.selectHighlightShelfObjects(selectedKeys);
                }
            });
            for (WorldMap.WorldMapChangedListener listener : this.worldMapChangedListeners) {
                manager.mapMaker.addMapChangedListener(listener);
            }
        }

        private int[] getSelectedKeys() {
            return Arrays.stream(this.shelfTbl.getSelectedRows()).map(rowIndex -> Integer.valueOf(this.shelfTbl.getValueAt(rowIndex, 0).toString())).toArray();
        }

        private int[] getAllSelectedKeys() {
            int[] selectedKeys = new int[this.shelfTbl.getRowCount()];
            int i = 0;
            while (i < this.shelfTbl.getRowCount()) {
                selectedKeys[i] = Integer.valueOf(String.valueOf(this.shelfTbl.getValueAt(i, 0)));
                ++i;
            }
            return selectedKeys;
        }

        private void setTableRows(WorldMap map) {
            this.selectShelfObjects(map);
            Vector dataVector = new Vector();
            for (Map.Entry<Integer, FreeShelfObject> entry : this.allShelfObjects.entrySet()) {
                Vector<String> vector = new Vector<String>();
                FreeShelfObject obj = entry.getValue();
                vector.add(String.valueOf(obj.id()));
                vector.add(obj.shelf().name);
                vector.add(obj.shelf().name);
                dataVector.add(vector);
            }
            Vector<String> columnIdentifiers = new Vector<String>();
            columnIdentifiers.add("ID");
            columnIdentifiers.add("棚名");
            ((DefaultTableModel)this.shelfTbl.getModel()).setDataVector(dataVector, columnIdentifiers);
            this.shelfTbl.getColumnModel().getColumn(0).setPreferredWidth(0);
            this.shelfTbl.getColumnModel().getColumn(0).setMinWidth(0);
            this.shelfTbl.getColumnModel().getColumn(0).setMaxWidth(0);
            this.shelfTbl.getColumnModel().getColumn(0).setWidth(0);
            this.shelfTbl.getColumnModel().getColumn(0).setCellEditor(null);
            this.shelfTbl.getColumnModel().getColumn(1).setCellEditor(null);
            JTableHeader jheader = this.shelfTbl.getTableHeader();
            jheader.setReorderingAllowed(false);
        }

        private void selectShelfObjects(WorldMap map) {
            this.allShelfObjects.clear();
            if (map != null) {
                for (AbstractObject obj : map.objects()) {
                    if (!FreeShelfObject.class.isInstance(obj)) continue;
                    this.allShelfObjects.put(obj.id(), (FreeShelfObject)obj);
                }
            }
        }

        private void selectHighlightShelfObjects(int[] selectedKeys) {
            this.highlightShelfObjects.clear();
            int[] nArray = selectedKeys;
            int n = selectedKeys.length;
            int n2 = 0;
            while (n2 < n) {
                int key = nArray[n2];
                if (this.allShelfObjects.containsKey(key)) {
                    this.highlightShelfObjects.add(this.allShelfObjects.get(key));
                }
                ++n2;
            }
        }

        public void destroy() {
            for (WorldMap.WorldMapChangedListener listener : this.worldMapChangedListeners) {
                this.manager.mapMaker.removeMapChangedListener(listener);
            }
        }

        private void SearchConditionChange(HashSet<RowFilter<? super TableModel, ? super Integer>> filters) {
            if (this.chkShelfNameIsSpace.isSelected() || this.chkShelfNameIsDuplicate.isSelected()) {
                this.filterTextField.setText("");
                this.filterTextField.setEnabled(false);
                this.filterTextField.setBackground(Color.GRAY);
            } else {
                this.filterTextField.setEnabled(true);
                this.filterTextField.setBackground(Color.WHITE);
            }
            this.sorter.setRowFilter(RowFilter.andFilter(filters));
            this.sorter.setSortKeys(this.sortKeys);
            this.shelfTbl.selectAll();
        }
    }

    public static class ShelfSearchPanel
    extends AbstractMapPanel {
        final ShelfSearchManager manager;

        public ShelfSearchPanel(ShelfSearchManager manager) {
            this.manager = manager;
        }

        @Override
        public void draw(Graphics2D g) {
            for (FreeShelfObject obj : ((ShelfSearchManager)this.manager).frame.highlightShelfObjects) {
                obj.highlight(g, this.mapView());
            }
        }
    }
}

