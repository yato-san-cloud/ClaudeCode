/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.mapmaker.commands;

import com.hitachi.warehouse.mapmaker.MapMaker;
import com.hitachi.warehouse.mapmaker.WorldMapExtension;
import com.hitachi.warehouse.mapmaker.common.NumericCheck;
import com.hitachi.warehouse.model.map.WaypointGraph;
import com.hitachi.warehouse.model.map.WorldMap;
import com.hitachi.warehouse.model.map.objects.StairsObject;
import java.awt.BorderLayout;
import java.awt.Component;
import java.awt.Dimension;
import java.awt.FlowLayout;
import java.awt.Frame;
import java.awt.event.ActionEvent;
import java.awt.event.ActionListener;
import java.text.DecimalFormat;
import java.util.ArrayList;
import java.util.Vector;
import javax.swing.DefaultCellEditor;
import javax.swing.JButton;
import javax.swing.JComboBox;
import javax.swing.JDialog;
import javax.swing.JLabel;
import javax.swing.JOptionPane;
import javax.swing.JPanel;
import javax.swing.JScrollPane;
import javax.swing.JTable;
import javax.swing.JTextField;
import javax.swing.RowSorter;
import javax.swing.SortOrder;
import javax.swing.table.DefaultTableModel;
import javax.swing.table.JTableHeader;
import javax.swing.table.TableModel;
import javax.swing.table.TableRowSorter;

public class StairsLinkManeger {
    private MapMaker mapMaker;
    private JDialog dlgMultiFloorSeting;
    private JTable TblStairsLinkList;

    public StairsLinkManeger(MapMaker mapMaker) {
        this.mapMaker = mapMaker;
    }

    public void open() {
        ArrayList<String> errorMessage_calc = new ArrayList<String>();
        for (WorldMapExtension worldMapExtension : this.mapMaker.worldMapMultiFloor.getWorldMapExtensionList()) {
            WorldMap map = worldMapExtension.getWorldMap();
            WaypointGraph graph = map.cartGraph();
            if (graph != null) continue;
            errorMessage_calc.add("「" + worldMapExtension.getName() + "」");
        }
        if (errorMessage_calc.size() != 0) {
            String errorMessage = "以下のフロアーの経路キャッシュ計算が完了していません。\n";
            for (String str : errorMessage_calc) {
                errorMessage = String.valueOf(errorMessage) + str + " ";
            }
            JOptionPane.showMessageDialog(this.mapMaker.mapFrame, errorMessage, "エラー", 0);
            return;
        }
        ArrayList<String> errorMessage_createCartGraph = this.mapMaker.worldMapMultiFloor.CreateMultiFloorStairsCartGraph();
        String errorMessage = null;
        for (String str : errorMessage_createCartGraph) {
            if (str == null) continue;
            if (errorMessage == null) {
                errorMessage = "フロアー間の階段の接続に問題があります。\n\n";
            }
            errorMessage = String.valueOf(errorMessage) + str + "\n";
        }
        if (errorMessage != null) {
            JOptionPane.showMessageDialog(this.mapMaker.mapFrame, errorMessage, "エラー", 0);
            return;
        }
        this.dlgMultiFloorSeting = new JDialog((Frame)this.mapMaker.mapFrame, true);
        this.dlgMultiFloorSeting.setTitle("階段設定");
        this.dlgMultiFloorSeting.setSize(600, 500);
        this.dlgMultiFloorSeting.setLocationRelativeTo(null);
        JPanel pnlMain = new JPanel();
        pnlMain.setLayout(new BorderLayout());
        JPanel pnlDescription = new JPanel();
        pnlDescription.setLayout(null);
        pnlDescription.setPreferredSize(new Dimension(this.dlgMultiFloorSeting.getWidth(), 100));
        JLabel lblDescription1 = new JLabel("■各フロアーを繋ぐ階段の進行方向と距離を入力して下さい");
        lblDescription1.setBounds(5, 5, 400, 25);
        JLabel lblDescription2 = new JLabel("・各フロアー間を同じ名前の階段で組み合わせて接続しています。");
        lblDescription2.setBounds(30, 35, 400, 25);
        JLabel lblDescription3 = new JLabel("・組み合わせの無い階段は表示していません。");
        lblDescription3.setBounds(30, 65, 400, 25);
        pnlDescription.add(lblDescription1);
        pnlDescription.add(lblDescription2);
        pnlDescription.add(lblDescription3);
        pnlMain.add((Component)pnlDescription, "North");
        JScrollPane pnlScl = new JScrollPane();
        pnlScl.setVerticalScrollBarPolicy(22);
        pnlScl.setHorizontalScrollBarPolicy(31);
        DefaultTableModel model = new DefaultTableModel();
        this.TblStairsLinkList = new JTable(model){

            @Override
            public boolean isCellEditable(int row, int column) {
                return column == 2 || column == 5;
            }
        };
        this.TblStairsLinkList.setSelectionMode(1);
        Vector<String> columnIdentifiers = new Vector<String>();
        columnIdentifiers.add("Floor");
        columnIdentifiers.add("階段");
        columnIdentifiers.add("通行方向");
        columnIdentifiers.add("Floor");
        columnIdentifiers.add("階段");
        columnIdentifiers.add("距離(mm)");
        columnIdentifiers.add("from Stairs");
        columnIdentifiers.add("to   Stairs");
        columnIdentifiers.add("from Floor");
        columnIdentifiers.add("to   Floor");
        Vector dataVector = new Vector();
        int cnt = 0;
        while (cnt < this.mapMaker.worldMapMultiFloor.StairsBetweenDistanceList.size()) {
            WorldMapExtension FromFloor = this.mapMaker.worldMapMultiFloor.StairsBetweenDistanceList.get((int)cnt).FromFloor;
            StairsObject FromStairsObject = this.mapMaker.worldMapMultiFloor.StairsBetweenDistanceList.get((int)cnt).FromStairsObject;
            WorldMapExtension ToFloor = this.mapMaker.worldMapMultiFloor.StairsBetweenDistanceList.get((int)cnt).ToFloor;
            StairsObject ToStairsObject = this.mapMaker.worldMapMultiFloor.StairsBetweenDistanceList.get((int)cnt).ToStairsObject;
            double distance = this.mapMaker.worldMapMultiFloor.StairsBetweenDistanceList.get((int)cnt).Distance;
            Vector<Object> vector = new Vector<Object>();
            boolean add = true;
            int row = 0;
            while (row < dataVector.size()) {
                Vector rowdata = (Vector)dataVector.get(row);
                if (rowdata.get(6).equals(ToStairsObject) && rowdata.get(7).equals(FromStairsObject) || rowdata.get(6).equals(FromStairsObject) && rowdata.get(7).equals(ToStairsObject)) {
                    rowdata.set(2, "⇔");
                    add = false;
                }
                ++row;
            }
            if (add) {
                DecimalFormat df;
                int ToFloorNo;
                int FromFloorNo = this.mapMaker.worldMapMultiFloor.getFloorNoforStairsObject(FromStairsObject);
                if (FromFloorNo < (ToFloorNo = this.mapMaker.worldMapMultiFloor.getFloorNoforStairsObject(ToStairsObject))) {
                    vector.add(FromFloor.getName());
                    vector.add(FromStairsObject.getName());
                    vector.add("→");
                    vector.add(ToFloor.getName());
                    vector.add(ToStairsObject.getName());
                    df = new DecimalFormat("#.##########");
                    vector.add(df.format(distance));
                    vector.add(FromStairsObject);
                    vector.add(ToStairsObject);
                    vector.add(FromFloor);
                    vector.add(ToFloor);
                } else {
                    vector.add(ToFloor.getName());
                    vector.add(ToStairsObject.getName());
                    vector.add("←");
                    vector.add(FromFloor.getName());
                    vector.add(FromStairsObject.getName());
                    df = new DecimalFormat("#.##########");
                    vector.add(df.format(distance));
                    vector.add(ToStairsObject);
                    vector.add(FromStairsObject);
                    vector.add(ToFloor);
                    vector.add(FromFloor);
                }
                dataVector.add(vector);
            }
            ++cnt;
        }
        ((DefaultTableModel)this.TblStairsLinkList.getModel()).setDataVector(dataVector, columnIdentifiers);
        this.TblStairsLinkList.getColumnModel().getColumn(2).setCellEditor(new DefaultCellEditor(new JComboBox<String>(new String[]{"⇔", "→", "←"})));
        JTextField txtDistance = new JTextField();
        DefaultCellEditor ce = new DefaultCellEditor(txtDistance);
        ce.setClickCountToStart(1);
        this.TblStairsLinkList.getColumnModel().getColumn(5).setCellEditor(ce);
        this.TblStairsLinkList.getColumnModel().getColumn(0).setCellEditor(null);
        this.TblStairsLinkList.getColumnModel().getColumn(1).setCellEditor(null);
        this.TblStairsLinkList.getColumnModel().getColumn(3).setCellEditor(null);
        this.TblStairsLinkList.getColumnModel().getColumn(4).setCellEditor(null);
        this.TblStairsLinkList.getColumnModel().getColumn(6).setCellEditor(null);
        this.TblStairsLinkList.getColumnModel().getColumn(7).setCellEditor(null);
        this.TblStairsLinkList.getColumnModel().getColumn(8).setCellEditor(null);
        this.TblStairsLinkList.getColumnModel().getColumn(9).setCellEditor(null);
        this.TblStairsLinkList.getColumnModel().getColumn(6).setPreferredWidth(0);
        this.TblStairsLinkList.getColumnModel().getColumn(6).setMinWidth(0);
        this.TblStairsLinkList.getColumnModel().getColumn(6).setMaxWidth(0);
        this.TblStairsLinkList.getColumnModel().getColumn(6).setWidth(0);
        this.TblStairsLinkList.getColumnModel().getColumn(7).setPreferredWidth(0);
        this.TblStairsLinkList.getColumnModel().getColumn(7).setMinWidth(0);
        this.TblStairsLinkList.getColumnModel().getColumn(7).setMaxWidth(0);
        this.TblStairsLinkList.getColumnModel().getColumn(7).setWidth(0);
        this.TblStairsLinkList.getColumnModel().getColumn(8).setPreferredWidth(0);
        this.TblStairsLinkList.getColumnModel().getColumn(8).setMinWidth(0);
        this.TblStairsLinkList.getColumnModel().getColumn(8).setMaxWidth(0);
        this.TblStairsLinkList.getColumnModel().getColumn(8).setWidth(0);
        this.TblStairsLinkList.getColumnModel().getColumn(9).setPreferredWidth(0);
        this.TblStairsLinkList.getColumnModel().getColumn(9).setMinWidth(0);
        this.TblStairsLinkList.getColumnModel().getColumn(9).setMaxWidth(0);
        this.TblStairsLinkList.getColumnModel().getColumn(9).setWidth(0);
        JTableHeader jheader = this.TblStairsLinkList.getTableHeader();
        jheader.setReorderingAllowed(false);
        this.TblStairsLinkList.setAutoCreateRowSorter(true);
        TableRowSorter<TableModel> trs = new TableRowSorter<TableModel>(this.TblStairsLinkList.getModel());
        ArrayList<RowSorter.SortKey> myAl = new ArrayList<RowSorter.SortKey>();
        myAl.add(new RowSorter.SortKey(0, SortOrder.ASCENDING));
        myAl.add(new RowSorter.SortKey(1, SortOrder.ASCENDING));
        myAl.add(new RowSorter.SortKey(3, SortOrder.ASCENDING));
        myAl.add(new RowSorter.SortKey(4, SortOrder.ASCENDING));
        ((RowSorter)trs).setSortKeys(myAl);
        this.TblStairsLinkList.setRowSorter(trs);
        pnlScl.setViewportView(this.TblStairsLinkList);
        pnlMain.add((Component)pnlScl, "Center");
        JPanel pnlBtn = new JPanel();
        pnlBtn.setLayout(new FlowLayout());
        JButton btnOK = new JButton("OK");
        if (this.TblStairsLinkList.getRowCount() == 0) {
            btnOK.setVisible(false);
        }
        JButton btnCancel = new JButton("CANCEL");
        pnlBtn.add(btnOK);
        pnlBtn.add(btnCancel);
        pnlMain.add((Component)pnlBtn, "South");
        this.dlgMultiFloorSeting.add(pnlMain);
        this.dlgMultiFloorSeting.repaint();
        this.dlgMultiFloorSeting.validate();
        btnOK.addActionListener(new ActionListener(){

            @Override
            public void actionPerformed(ActionEvent e) {
                new Thread(){

                    @Override
                    public void run() {
                        if (StairsLinkManeger.this.TblStairsLinkList.isEditing()) {
                            StairsLinkManeger.this.TblStairsLinkList.getCellEditor().stopCellEditing();
                        }
                        int row = 0;
                        while (row < StairsLinkManeger.this.TblStairsLinkList.getRowCount()) {
                            String direction = (String)StairsLinkManeger.this.TblStairsLinkList.getValueAt(row, 2);
                            NumericCheck nc = new NumericCheck();
                            String strdistance = StairsLinkManeger.this.TblStairsLinkList.getValueAt(row, 5).toString();
                            if (!nc.isNumericDouble(strdistance)) {
                                JOptionPane.showMessageDialog(StairsLinkManeger.this.dlgMultiFloorSeting, "距離は、数値を入力してください。", "エラー", 0);
                                StairsLinkManeger.this.TblStairsLinkList.changeSelection(row, 5, false, false);
                                return;
                            }
                            double distance = Double.parseDouble(StairsLinkManeger.this.TblStairsLinkList.getValueAt(row, 5).toString());
                            if (distance > 1000000.0) {
                                JOptionPane.showMessageDialog(StairsLinkManeger.this.dlgMultiFloorSeting, "距離は、1,000,000（1km）までの値を入力してください。", "エラー", 0);
                                StairsLinkManeger.this.TblStairsLinkList.changeSelection(row, 5, false, false);
                                return;
                            }
                            if (distance <= 0.0) {
                                JOptionPane.showMessageDialog(StairsLinkManeger.this.dlgMultiFloorSeting, "階段の距離が不正です。", "エラー", 0);
                                StairsLinkManeger.this.TblStairsLinkList.changeSelection(row, 5, false, false);
                                return;
                            }
                            WorldMapExtension FromFloor = (WorldMapExtension)StairsLinkManeger.this.TblStairsLinkList.getValueAt(row, 8);
                            WorldMapExtension ToFloor = (WorldMapExtension)StairsLinkManeger.this.TblStairsLinkList.getValueAt(row, 9);
                            StairsObject FromStairsObject = (StairsObject)StairsLinkManeger.this.TblStairsLinkList.getValueAt(row, 6);
                            StairsObject ToStairsObject = (StairsObject)StairsLinkManeger.this.TblStairsLinkList.getValueAt(row, 7);
                            if (direction.equals("⇔")) {
                                ((StairsLinkManeger)(this).StairsLinkManeger.this).mapMaker.worldMapMultiFloor.SetStairsBetweenDistanceList(FromFloor, FromStairsObject, ToFloor, ToStairsObject, distance);
                                ((StairsLinkManeger)(this).StairsLinkManeger.this).mapMaker.worldMapMultiFloor.SetStairsBetweenDistanceList(ToFloor, ToStairsObject, FromFloor, FromStairsObject, distance);
                            } else if (direction.equals("→")) {
                                ((StairsLinkManeger)(this).StairsLinkManeger.this).mapMaker.worldMapMultiFloor.SetStairsBetweenDistanceList(FromFloor, FromStairsObject, ToFloor, ToStairsObject, distance);
                                ((StairsLinkManeger)(this).StairsLinkManeger.this).mapMaker.worldMapMultiFloor.RemoveStairsBetweenDistanceList(ToStairsObject, FromStairsObject);
                            } else if (direction.equals("←")) {
                                ((StairsLinkManeger)(this).StairsLinkManeger.this).mapMaker.worldMapMultiFloor.SetStairsBetweenDistanceList(ToFloor, ToStairsObject, FromFloor, FromStairsObject, distance);
                                ((StairsLinkManeger)(this).StairsLinkManeger.this).mapMaker.worldMapMultiFloor.RemoveStairsBetweenDistanceList(FromStairsObject, ToStairsObject);
                            }
                            ++row;
                        }
                        StairsLinkManeger.this.dlgMultiFloorSeting.setEnabled(false);
                        boolean FloorLinkMPassCheck = ((StairsLinkManeger)(this).StairsLinkManeger.this).mapMaker.worldMapMultiFloor.FloorLinkMPassCheck();
                        if (!FloorLinkMPassCheck) {
                            StairsLinkManeger.this.dlgMultiFloorSeting.setEnabled(true);
                            return;
                        }
                        StairsLinkManeger.this.dlgMultiFloorSeting.setVisible(false);
                    }
                }.start();
            }
        });
        btnCancel.addActionListener(new ActionListener(){

            @Override
            public void actionPerformed(ActionEvent e) {
                if (StairsLinkManeger.this.TblStairsLinkList.isEditing()) {
                    StairsLinkManeger.this.TblStairsLinkList.getCellEditor().stopCellEditing();
                }
                StairsLinkManeger.this.dlgMultiFloorSeting.setVisible(false);
            }
        });
        this.dlgMultiFloorSeting.setVisible(true);
    }
}

