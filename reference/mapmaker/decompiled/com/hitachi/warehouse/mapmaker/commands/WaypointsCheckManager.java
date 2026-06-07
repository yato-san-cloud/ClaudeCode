/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.mapmaker.commands;

import com.hitachi.warehouse.gui.mapframe.AbstractMapPanel;
import com.hitachi.warehouse.mapmaker.MapMaker;
import com.hitachi.warehouse.mapmaker.networkgenerator.NetworkCalculatorManager;
import com.hitachi.warehouse.model.map.Waypoint;
import com.hitachi.warehouse.model.map.WaypointGraph;
import com.hitachi.warehouse.model.map.objects.AbstractObject;
import com.hitachi.warehouse.model.map.objects.AbstractRectangleObject;
import com.hitachi.warehouse.model.map.objects.FreeShelfObject;
import java.awt.BorderLayout;
import java.awt.Component;
import java.awt.Dimension;
import java.awt.Graphics2D;
import java.awt.event.ActionEvent;
import java.awt.event.ActionListener;
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
import java.util.Set;
import java.util.Vector;
import javax.swing.ButtonGroup;
import javax.swing.JFrame;
import javax.swing.JLabel;
import javax.swing.JPanel;
import javax.swing.JRadioButton;
import javax.swing.JScrollPane;
import javax.swing.JTable;
import javax.swing.RowSorter;
import javax.swing.SortOrder;
import javax.swing.event.ListSelectionEvent;
import javax.swing.event.ListSelectionListener;
import javax.swing.table.DefaultTableModel;
import javax.swing.table.JTableHeader;
import javax.swing.table.TableModel;
import javax.swing.table.TableRowSorter;

public class WaypointsCheckManager {
    private WaypointsCheckFrame frame = null;
    private WaypointsCheckPanel panel = null;
    private MapMaker mapMaker;

    public WaypointsCheckFrame getWaypointsCheckFrame() {
        return this.frame;
    }

    public WaypointsCheckManager(MapMaker mapMaker) {
        this.mapMaker = mapMaker;
    }

    public void open() {
        if (this.panel == null) {
            this.panel = new WaypointsCheckPanel(this);
            this.mapMaker.mapFrame.mapView.openChildView(this.panel);
        }
        if (this.frame == null) {
            this.frame = new WaypointsCheckFrame(this);
            this.frame.addWindowListener(new WindowAdapter(){

                @Override
                public void windowClosing(WindowEvent e) {
                    ((WaypointsCheckManager)WaypointsCheckManager.this).mapMaker.mapFrame.mapView.closeChildview(WaypointsCheckManager.this.panel);
                    WaypointsCheckManager.this.frame.destroy();
                    super.windowClosing(e);
                    WaypointsCheckManager.this.panel = null;
                    WaypointsCheckManager.this.frame = null;
                }
            });
        }
        this.frame.setLocationRelativeTo(this.mapMaker.mapFrame);
        this.frame.setVisible(true);
    }

    public static class WaypointsCheckFrame
    extends JFrame {
        final WaypointsCheckManager manager;
        final Map<Integer, FreeShelfObject> allShelfObjects = new HashMap<Integer, FreeShelfObject>();
        final List<FreeShelfObject> highlightShelfObjects = new ArrayList<FreeShelfObject>();
        final DefaultTableModel model = new DefaultTableModel();
        final JTable shelfTbl = new JTable(this.model){

            @Override
            public boolean isCellEditable(int row, int column) {
                return false;
            }
        };
        final TableRowSorter<TableModel> sorter = new TableRowSorter();
        final JRadioButton caRadioON = new JRadioButton("ON");
        final JRadioButton caRadioOFF = new JRadioButton("OFF");
        boolean constrainedAreaCheckDetail = true;
        private JRadioButton chkShelfMultiPic;
        private JRadioButton chkShelfNonPic;
        WaypointGraph cartGraph = null;
        private ArrayList<RowSorter.SortKey> sortKeys = new ArrayList();
        List<NetworkCalculatorManager.NetworkCalculatorManagerListener> networkCalculatorManagerListeners = new ArrayList<NetworkCalculatorManager.NetworkCalculatorManagerListener>();

        public WaypointsCheckFrame(final WaypointsCheckManager manager) {
            Collections.unmodifiableList(this.sortKeys);
            this.sortKeys.add(new RowSorter.SortKey(1, SortOrder.ASCENDING));
            this.sortKeys.add(new RowSorter.SortKey(0, SortOrder.ASCENDING));
            this.manager = manager;
            this.setTitle("WaypointsCheck");
            this.setLayout(new BorderLayout());
            this.cartGraph = manager.mapMaker.map().cartGraph();
            JPanel pnlConditions = new JPanel();
            pnlConditions.setLayout(null);
            pnlConditions.setPreferredSize(new Dimension(this.getWidth(), 90));
            JLabel lblTitle = new JLabel("■商品のピック面数チェック");
            lblTitle.setBounds(5, 1, 250, 25);
            pnlConditions.add(lblTitle);
            this.chkShelfMultiPic = new JRadioButton("ピック面が複数有る棚");
            this.chkShelfMultiPic.setBounds(15, 25, 250, 25);
            this.chkShelfMultiPic.setSelected(true);
            pnlConditions.add(this.chkShelfMultiPic);
            this.chkShelfMultiPic.addItemListener(new ItemListener(){

                @Override
                public void itemStateChanged(ItemEvent e) {
                    cartGraph = manager.mapMaker.map().cartGraph();
                    this.setTableRows(true);
                    sorter.setSortKeys(sortKeys);
                }
            });
            this.chkShelfNonPic = new JRadioButton("ピック面が無い棚");
            this.chkShelfNonPic.setBounds(15, 50, 250, 25);
            pnlConditions.add(this.chkShelfNonPic);
            ButtonGroup grpSearchCondition = new ButtonGroup();
            grpSearchCondition.add(this.chkShelfMultiPic);
            grpSearchCondition.add(this.chkShelfNonPic);
            this.add((Component)pnlConditions, "North");
            this.setTableRows(true);
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
            ButtonGroup group = new ButtonGroup();
            group.add(this.caRadioON);
            group.add(this.caRadioOFF);
            JPanel northPanel = new JPanel();
            northPanel.add(new JLabel("制約領域上のWaypointをまとめる。"));
            northPanel.add(this.caRadioOFF);
            northPanel.add(this.caRadioON);
            this.sorter.setModel(this.shelfTbl.getModel());
            this.sorter.setSortKeys(this.sortKeys);
            this.shelfTbl.setRowSorter(this.sorter);
            this.shelfTbl.selectAll();
            this.pack();
            this.setVisible(true);
            this.networkCalculatorManagerListeners.add(new NetworkCalculatorManager.NetworkCalculatorManagerListener(){

                @Override
                public void generateFinished(WaypointGraph graph) {
                    if (manager.mapMaker.getCalculatorManager().isErrorInfo() == null) {
                        cartGraph = graph;
                        this.setTableRows(false);
                        this.selectHighlightShelfObjects(highlightShelfObjects.stream().mapToInt(obj -> obj.id()).toArray());
                        sorter.setSortKeys(sortKeys);
                    }
                }
            });
            for (NetworkCalculatorManager.NetworkCalculatorManagerListener listener : this.networkCalculatorManagerListeners) {
                manager.mapMaker.getCalculatorManager().addListener(listener);
            }
            ActionListener onOffChangeListener = new ActionListener(){

                @Override
                public void actionPerformed(ActionEvent e) {
                    constrainedAreaCheckDetail = caRadioON.isSelected();
                    if (cartGraph != null) {
                        this.setTableRows(true);
                    }
                }
            };
            this.caRadioON.addActionListener(onOffChangeListener);
            this.caRadioOFF.addActionListener(onOffChangeListener);
            this.caRadioON.setSelected(true);
        }

        private int[] getSelectedKeys() {
            return Arrays.stream(this.shelfTbl.getSelectedRows()).map(rowIndex -> Integer.valueOf(this.shelfTbl.getValueAt(rowIndex, 0).toString())).toArray();
        }

        private void setTableRows(boolean isSelectedAll) {
            int[] selectedKeys = this.getSelectedKeys();
            this.selectShelfObjects();
            Vector dataVector = new Vector();
            for (Map.Entry<Integer, FreeShelfObject> entry : this.allShelfObjects.entrySet()) {
                Vector<String> vector = new Vector<String>();
                FreeShelfObject obj = entry.getValue();
                vector.add(String.valueOf(obj.id()));
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
            if (isSelectedAll) {
                this.shelfTbl.selectAll();
            } else {
                this.selectHighlightShelfObjects(selectedKeys);
                int row = 0;
                while (row < this.shelfTbl.getRowCount()) {
                    int currentKey = Integer.valueOf(this.shelfTbl.getValueAt(row, 0).toString());
                    if (Arrays.stream(selectedKeys).anyMatch(key -> key == currentKey)) {
                        this.shelfTbl.addRowSelectionInterval(row, row);
                    }
                    ++row;
                }
            }
        }

        private void selectShelfObjects() {
            this.allShelfObjects.clear();
            if (this.cartGraph != null) {
                for (AbstractObject rect : this.cartGraph.map.objects()) {
                    if (!FreeShelfObject.class.isInstance(rect)) continue;
                    Set<Waypoint> waypoints = this.cartGraph.waypointsForRect((AbstractRectangleObject)rect);
                    HashSet<Waypoint> counter = new HashSet<Waypoint>();
                    if (this.constrainedAreaCheckDetail) {
                        for (Waypoint w1 : waypoints) {
                            boolean contains = false;
                            for (Waypoint w2 : counter) {
                                if (!w1.coord().equals(w2.coord())) continue;
                                contains = true;
                                break;
                            }
                            if (contains) continue;
                            counter.add(w1);
                        }
                    } else {
                        counter.addAll(waypoints);
                    }
                    if (this.chkShelfMultiPic.isSelected()) {
                        if (counter.size() <= 1) continue;
                        this.allShelfObjects.put(rect.id(), (FreeShelfObject)rect);
                        continue;
                    }
                    if (counter.size() != 0) continue;
                    this.allShelfObjects.put(rect.id(), (FreeShelfObject)rect);
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
            for (NetworkCalculatorManager.NetworkCalculatorManagerListener listener : this.networkCalculatorManagerListeners) {
                this.manager.mapMaker.getCalculatorManager().removeListener(listener);
            }
        }

        public void setGraph(WaypointGraph graph) {
            this.cartGraph = graph;
            this.setTableRows(false);
            this.selectHighlightShelfObjects(this.highlightShelfObjects.stream().mapToInt(obj -> obj.id()).toArray());
            this.sorter.setSortKeys(this.sortKeys);
        }
    }

    public static class WaypointsCheckPanel
    extends AbstractMapPanel {
        final WaypointsCheckManager manager;

        public WaypointsCheckPanel(WaypointsCheckManager manager) {
            this.manager = manager;
        }

        @Override
        public void draw(Graphics2D g) {
            for (FreeShelfObject obj : ((WaypointsCheckManager)this.manager).frame.highlightShelfObjects) {
                obj.highlight(g, this.mapView());
            }
        }
    }
}

