/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.mapmaker;

import com.hitachi.warehouse.mapmaker.FloorTab;
import com.hitachi.warehouse.mapmaker.MapMaker;
import com.hitachi.warehouse.mapmaker.OperationMode;
import com.hitachi.warehouse.mapmaker.WorldMapExtension;
import com.hitachi.warehouse.model.common.Coord;
import com.hitachi.warehouse.model.map.WorldMap;
import java.awt.Color;
import java.awt.Dimension;
import java.awt.event.ActionEvent;
import java.awt.event.ActionListener;
import java.awt.event.FocusEvent;
import java.awt.event.FocusListener;
import java.awt.event.KeyEvent;
import java.awt.event.KeyListener;
import java.awt.event.MouseEvent;
import java.awt.event.MouseListener;
import java.util.ArrayList;
import java.util.regex.Pattern;
import javax.swing.BoxLayout;
import javax.swing.JComponent;
import javax.swing.JMenuItem;
import javax.swing.JOptionPane;
import javax.swing.JPanel;
import javax.swing.JPopupMenu;
import javax.swing.JScrollPane;
import javax.swing.JTextField;
import javax.swing.event.PopupMenuEvent;
import javax.swing.event.PopupMenuListener;

public class FloorToolBar
extends JScrollPane {
    private static final long serialVersionUID = -3896431840967337437L;
    private boolean enabled = true;
    private MapMaker mapMaker;
    private JPanel pnlFloor = new JPanel();
    private ArrayList<FloorTab> floorTabList = new ArrayList();
    private int currentFloorTabIndex = -1;

    @Override
    public void setEnabled(boolean enabled) {
        this.enabled = enabled;
        for (FloorTab tab : this.floorTabList) {
            tab.getBtnFloorTab().setEnabled(enabled);
        }
    }

    public boolean getEnabled() {
        return this.enabled;
    }

    public FloorToolBar(MapMaker _mapMaker) {
        this.mapMaker = _mapMaker;
        this.pnlFloor.setLayout(new BoxLayout(this.pnlFloor, 0));
        this.setViewportView(this.pnlFloor);
        this.setVerticalScrollBarPolicy(21);
        this.setHorizontalScrollBarPolicy(32);
    }

    public ArrayList<FloorTab> getFloorTabList() {
        return this.floorTabList;
    }

    public void clear() {
        this.floorTabList.clear();
        this.currentFloorTabIndex = -1;
        this.ReCreatePanel();
        this.mapMaker.worldMapMultiFloor.clearWorldMapExtension();
    }

    public int getCurrentFloorTabIndex() {
        return this.currentFloorTabIndex;
    }

    public void setCurrentFloorTabIndex(int currentFloorTabIndex) {
        if (this.floorTabList.get(this.currentFloorTabIndex).equals(this.floorTabList.get(currentFloorTabIndex))) {
            return;
        }
        this.currentFloorTabIndex = currentFloorTabIndex;
        this.ReCreatePanel();
    }

    public void addBefore(FloorTab newFloorTab, WorldMap worldMap) {
        int index = this.currentFloorTabIndex;
        if (index != -1) {
            this.floorTabList.add(index, newFloorTab);
            this.currentFloorTabIndex = this.floorTabList.indexOf(newFloorTab);
        }
        this.ReCreatePanel();
        this.mapMaker.worldMapMultiFloor.addMap(index, worldMap, newFloorTab.getFloorName(), this.mapMaker.mapFrame.mapView.centerX(), this.mapMaker.mapFrame.mapView.centerY(), this.mapMaker.mapFrame.mapView.zoomLevel());
    }

    public void addAfter(FloorTab newFloorTab, WorldMap worldMap) {
        int index = this.currentFloorTabIndex;
        if (index == this.floorTabList.size() - 1) {
            this.floorTabList.add(newFloorTab);
            this.mapMaker.worldMapMultiFloor.addMap(worldMap, newFloorTab.getFloorName(), this.mapMaker.mapFrame.mapView.centerX(), this.mapMaker.mapFrame.mapView.centerY(), this.mapMaker.mapFrame.mapView.zoomLevel());
        } else {
            this.floorTabList.add(++index, newFloorTab);
            this.mapMaker.worldMapMultiFloor.addMap(index, worldMap, newFloorTab.getFloorName(), this.mapMaker.mapFrame.mapView.centerX(), this.mapMaker.mapFrame.mapView.centerY(), this.mapMaker.mapFrame.mapView.zoomLevel());
        }
        this.currentFloorTabIndex = this.floorTabList.indexOf(newFloorTab);
        this.ReCreatePanel();
    }

    public void addAfterTabOnly(FloorTab newFloorTab) {
        int index = this.currentFloorTabIndex;
        if (index == this.floorTabList.size() - 1) {
            this.floorTabList.add(newFloorTab);
        } else {
            this.floorTabList.add(++index, newFloorTab);
        }
        this.currentFloorTabIndex = this.floorTabList.indexOf(newFloorTab);
        this.ReCreatePanel();
    }

    public void moveBefore() {
        if (this.currentFloorTabIndex <= 0) {
            return;
        }
        FloorTab WorkTab = this.floorTabList.get(this.currentFloorTabIndex - 1);
        this.floorTabList.set(this.currentFloorTabIndex - 1, this.floorTabList.get(this.currentFloorTabIndex));
        this.floorTabList.set(this.currentFloorTabIndex, WorkTab);
        WorldMapExtension WorkMapData = this.mapMaker.worldMapMultiFloor.getWorldMapExtension(this.currentFloorTabIndex - 1);
        this.mapMaker.worldMapMultiFloor.setWorldMapExtension(this.currentFloorTabIndex - 1, this.mapMaker.worldMapMultiFloor.getWorldMapExtension(this.currentFloorTabIndex));
        this.mapMaker.worldMapMultiFloor.setWorldMapExtension(this.currentFloorTabIndex, WorkMapData);
        --this.currentFloorTabIndex;
        this.ReCreatePanel();
    }

    public void moveAfter() {
        if (this.currentFloorTabIndex == this.floorTabList.size() - 1) {
            return;
        }
        FloorTab WorkTab = this.floorTabList.get(this.currentFloorTabIndex + 1);
        this.floorTabList.set(this.currentFloorTabIndex + 1, this.floorTabList.get(this.currentFloorTabIndex));
        this.floorTabList.set(this.currentFloorTabIndex, WorkTab);
        WorldMapExtension WorkMapData = this.mapMaker.worldMapMultiFloor.getWorldMapExtension(this.currentFloorTabIndex + 1);
        this.mapMaker.worldMapMultiFloor.setWorldMapExtension(this.currentFloorTabIndex + 1, this.mapMaker.worldMapMultiFloor.getWorldMapExtension(this.currentFloorTabIndex));
        this.mapMaker.worldMapMultiFloor.setWorldMapExtension(this.currentFloorTabIndex, WorkMapData);
        ++this.currentFloorTabIndex;
        this.ReCreatePanel();
    }

    public void removeCurrentFloorTab() {
        if (this.floorTabList.size() == 1) {
            return;
        }
        this.floorTabList.remove(this.currentFloorTabIndex);
        this.mapMaker.worldMapMultiFloor.removeWorldMapExtension(this.currentFloorTabIndex);
        if (this.floorTabList.size() - 1 <= this.currentFloorTabIndex) {
            this.currentFloorTabIndex = this.floorTabList.size() - 1;
        }
        this.SetCurrentFloor(this.GetCurrentFloorTab());
        this.ReCreatePanel();
    }

    public void SetCurrentFloor(FloorTab floorTab) {
        int selectFloorTabIndex = this.floorTabList.indexOf(floorTab);
        if (selectFloorTabIndex != this.currentFloorTabIndex) {
            this.mapMaker.showInfoForObject(null, null);
        }
        this.mapMaker.worldMapMultiFloor.getWorldMapExtension(this.currentFloorTabIndex).setCenterX(this.mapMaker.mapFrame.mapView.centerX());
        this.mapMaker.worldMapMultiFloor.getWorldMapExtension(this.currentFloorTabIndex).setCenterY(this.mapMaker.mapFrame.mapView.centerY());
        this.mapMaker.worldMapMultiFloor.getWorldMapExtension(this.currentFloorTabIndex).setZoomLevel(this.mapMaker.mapFrame.mapView.zoomLevel());
        if (this.mapMaker.getCalculatorManager().isCalculating()) {
            this.GetCurrentFloorTab().getNetworkCalculatorManagerInfo().setNetworkCalculatorManagerInfo(true, this.mapMaker.getCalculatorManager().isErrorInfo(), this.mapMaker.getCalculatorManager().generator.getWarningErrorInfo(), this.mapMaker.getCalculatorManager().isInterrupt());
        } else {
            this.GetCurrentFloorTab().getNetworkCalculatorManagerInfo().setNetworkCalculatorManagerInfo(this.mapMaker.getCalculatorManager().isNeedsRecalc(), this.mapMaker.getCalculatorManager().isErrorInfo(), this.mapMaker.getCalculatorManager().generator.getWarningErrorInfo(), this.mapMaker.getCalculatorManager().isInterrupt());
        }
        this.currentFloorTabIndex = selectFloorTabIndex;
        if (!this.mapMaker.map().equals(this.mapMaker.worldMapMultiFloor.getWorldMapExtension(selectFloorTabIndex).getWorldMap())) {
            boolean VisibleShelfNameManager = this.mapMaker.map().shelfNameManager().isVisibleEditor();
            if (VisibleShelfNameManager) {
                this.mapMaker.map().shelfNameManager().closeEditor();
            }
            this.mapMaker.setMap(this.mapMaker.worldMapMultiFloor.getWorldMapExtension(selectFloorTabIndex).getWorldMap(), false);
            if (VisibleShelfNameManager) {
                this.mapMaker.map().shelfNameManager().openEditor();
            }
            this.mapMaker.resetOperationMode(this.mapMaker.mode());
        }
        this.mapMaker.mapFrame.mapView.setOrientation(this.mapMaker.worldMapMultiFloor.getWorldMapExtension(selectFloorTabIndex).getCenterX(), this.mapMaker.worldMapMultiFloor.getWorldMapExtension(selectFloorTabIndex).getCenterY(), this.mapMaker.worldMapMultiFloor.getWorldMapExtension(selectFloorTabIndex).getZoomLevel());
        if (this.mapMaker.getCalculatorManager().isCalculating()) {
            this.mapMaker.getCalculatorManager().setGeneratorNeedsInterrupt(true);
        }
        if (this.GetCurrentFloorTab().getNetworkCalculatorManagerInfo().getNeedsRecalc()) {
            this.mapMaker.getCalculatorManager().recalc();
        } else if (this.mapMaker.mode() == OperationMode.kDebug) {
            this.mapMaker.getCalculatorManager().setNeedsRecalc(true);
        } else {
            this.mapMaker.getCalculatorManager().setNeedsRecalc(false);
        }
        this.mapMaker.getCalculatorManager().setIsErrorInfo(this.GetCurrentFloorTab().getNetworkCalculatorManagerInfo().getErrorInfo());
        this.mapMaker.getCalculatorManager().generator.setWarningErrorInfo(this.GetCurrentFloorTab().getNetworkCalculatorManagerInfo().getWarningErrorInfo());
        this.mapMaker.getCalculatorManager().setIsInterrupt(this.GetCurrentFloorTab().getNetworkCalculatorManagerInfo().getInterrupt());
        this.ReCreatePanel();
    }

    public FloorTab GetCurrentFloorTab() {
        if (this.floorTabList.size() == 0) {
            return null;
        }
        return this.floorTabList.get(this.currentFloorTabIndex);
    }

    private void ReCreatePanel() {
        this.pnlFloor.removeAll();
        for (FloorTab floorTab : this.floorTabList) {
            if (floorTab.equals(this.GetCurrentFloorTab())) {
                this.SetSelect(floorTab);
            } else {
                this.SetUnSelect(floorTab);
            }
            this.pnlFloor.add(floorTab);
        }
        this.repaint();
        this.validate();
    }

    public FloorTab getNewFloorTab() {
        int tabcount = this.mapMaker.worldMapMultiFloor.getWorldMapExtensionList().size() + 1;
        String FloorName = "Floor";
        if (tabcount != 1) {
            FloorName = String.valueOf(FloorName) + "(" + String.valueOf(tabcount) + ")";
        }
        final FloorTab newFloorTab = new FloorTab(FloorName);
        JMenuItem MenuItemAddAfter = new JMenuItem("後に挿入");
        MenuItemAddAfter.addActionListener(new ActionListener(){

            @Override
            public void actionPerformed(ActionEvent e) {
                ((FloorToolBar)FloorToolBar.this).mapMaker.worldMapMultiFloor.getWorldMapExtension(FloorToolBar.this.currentFloorTabIndex).setCenterX(((FloorToolBar)FloorToolBar.this).mapMaker.mapFrame.mapView.centerX());
                ((FloorToolBar)FloorToolBar.this).mapMaker.worldMapMultiFloor.getWorldMapExtension(FloorToolBar.this.currentFloorTabIndex).setCenterY(((FloorToolBar)FloorToolBar.this).mapMaker.mapFrame.mapView.centerY());
                ((FloorToolBar)FloorToolBar.this).mapMaker.worldMapMultiFloor.getWorldMapExtension(FloorToolBar.this.currentFloorTabIndex).setZoomLevel(((FloorToolBar)FloorToolBar.this).mapMaker.mapFrame.mapView.zoomLevel());
                if (FloorToolBar.this.mapMaker.getCalculatorManager().isCalculating()) {
                    FloorToolBar.this.GetCurrentFloorTab().getNetworkCalculatorManagerInfo().setNetworkCalculatorManagerInfo(true, FloorToolBar.this.mapMaker.getCalculatorManager().isErrorInfo(), ((FloorToolBar)FloorToolBar.this).mapMaker.getCalculatorManager().generator.getWarningErrorInfo(), FloorToolBar.this.mapMaker.getCalculatorManager().isInterrupt());
                } else {
                    FloorToolBar.this.GetCurrentFloorTab().getNetworkCalculatorManagerInfo().setNetworkCalculatorManagerInfo(FloorToolBar.this.mapMaker.getCalculatorManager().isNeedsRecalc(), FloorToolBar.this.mapMaker.getCalculatorManager().isErrorInfo(), ((FloorToolBar)FloorToolBar.this).mapMaker.getCalculatorManager().generator.getWarningErrorInfo(), FloorToolBar.this.mapMaker.getCalculatorManager().isInterrupt());
                }
                FloorToolBar.this.mapMaker.forceOpenNewFile();
                ((FloorToolBar)FloorToolBar.this).mapMaker.mapFrame.mapView.setCenter(Coord.mean(FloorToolBar.this.mapMaker.map().tl(), FloorToolBar.this.mapMaker.map().br()));
                ((FloorToolBar)FloorToolBar.this).mapMaker.mapFrame.mapView.initializeZoomLevel();
                FloorToolBar.this.addAfter(FloorToolBar.this.getNewFloorTab(), FloorToolBar.this.mapMaker.map());
                if (FloorToolBar.this.mapMaker.getCalculatorManager().isCalculating()) {
                    FloorToolBar.this.mapMaker.getCalculatorManager().setGeneratorNeedsInterrupt(true);
                }
            }
        });
        JMenuItem MenuItemAddBefore = new JMenuItem("前に挿入");
        MenuItemAddBefore.addActionListener(new ActionListener(){

            @Override
            public void actionPerformed(ActionEvent e) {
                ((FloorToolBar)FloorToolBar.this).mapMaker.worldMapMultiFloor.getWorldMapExtension(FloorToolBar.this.currentFloorTabIndex).setCenterX(((FloorToolBar)FloorToolBar.this).mapMaker.mapFrame.mapView.centerX());
                ((FloorToolBar)FloorToolBar.this).mapMaker.worldMapMultiFloor.getWorldMapExtension(FloorToolBar.this.currentFloorTabIndex).setCenterY(((FloorToolBar)FloorToolBar.this).mapMaker.mapFrame.mapView.centerY());
                ((FloorToolBar)FloorToolBar.this).mapMaker.worldMapMultiFloor.getWorldMapExtension(FloorToolBar.this.currentFloorTabIndex).setZoomLevel(((FloorToolBar)FloorToolBar.this).mapMaker.mapFrame.mapView.zoomLevel());
                if (FloorToolBar.this.mapMaker.getCalculatorManager().isCalculating()) {
                    FloorToolBar.this.GetCurrentFloorTab().getNetworkCalculatorManagerInfo().setNetworkCalculatorManagerInfo(true, FloorToolBar.this.mapMaker.getCalculatorManager().isErrorInfo(), ((FloorToolBar)FloorToolBar.this).mapMaker.getCalculatorManager().generator.getWarningErrorInfo(), FloorToolBar.this.mapMaker.getCalculatorManager().isInterrupt());
                } else {
                    FloorToolBar.this.GetCurrentFloorTab().getNetworkCalculatorManagerInfo().setNetworkCalculatorManagerInfo(FloorToolBar.this.mapMaker.getCalculatorManager().isNeedsRecalc(), FloorToolBar.this.mapMaker.getCalculatorManager().isErrorInfo(), ((FloorToolBar)FloorToolBar.this).mapMaker.getCalculatorManager().generator.getWarningErrorInfo(), FloorToolBar.this.mapMaker.getCalculatorManager().isInterrupt());
                }
                FloorToolBar.this.mapMaker.forceOpenNewFile();
                ((FloorToolBar)FloorToolBar.this).mapMaker.mapFrame.mapView.setCenter(Coord.mean(FloorToolBar.this.mapMaker.map().tl(), FloorToolBar.this.mapMaker.map().br()));
                ((FloorToolBar)FloorToolBar.this).mapMaker.mapFrame.mapView.initializeZoomLevel();
                FloorToolBar.this.addBefore(FloorToolBar.this.getNewFloorTab(), FloorToolBar.this.mapMaker.map());
                if (FloorToolBar.this.mapMaker.getCalculatorManager().isCalculating()) {
                    FloorToolBar.this.mapMaker.getCalculatorManager().setGeneratorNeedsInterrupt(true);
                }
            }
        });
        JMenuItem MenuItemDel = new JMenuItem("削除");
        MenuItemDel.addActionListener(new ActionListener(){

            @Override
            public void actionPerformed(ActionEvent e) {
                int option = JOptionPane.showConfirmDialog(null, "タブを削除します。よろしいですか？", "確認", 2, 3);
                if (option == 0) {
                    FloorToolBar.this.removeCurrentFloorTab();
                }
            }
        });
        JMenuItem MenuItemUpdateName = new JMenuItem("名前変更");
        MenuItemUpdateName.addActionListener(new ActionListener(){

            @Override
            public void actionPerformed(ActionEvent e) {
                FloorToolBar.this.SetNameUpdateMode(newFloorTab, true);
            }
        });
        JMenuItem MenuItemMoveAfter = new JMenuItem("後へ移動");
        MenuItemMoveAfter.addActionListener(new ActionListener(){

            @Override
            public void actionPerformed(ActionEvent e) {
                FloorToolBar.this.moveAfter();
            }
        });
        JMenuItem MenuItemMoveBefore = new JMenuItem("前へ移動");
        MenuItemMoveBefore.addActionListener(new ActionListener(){

            @Override
            public void actionPerformed(ActionEvent e) {
                FloorToolBar.this.moveBefore();
            }
        });
        final JPopupMenu popupmenu = new JPopupMenu();
        popupmenu.add(MenuItemAddAfter);
        popupmenu.add(MenuItemAddBefore);
        popupmenu.add(MenuItemDel);
        popupmenu.add(MenuItemUpdateName);
        popupmenu.add(MenuItemMoveAfter);
        popupmenu.add(MenuItemMoveBefore);
        popupmenu.addPopupMenuListener(new PopupMenuListener(){

            @Override
            public void popupMenuWillBecomeVisible(PopupMenuEvent e) {
                JPopupMenu m = (JPopupMenu)e.getSource();
                JMenuItem MenuItemAddAfter = (JMenuItem)m.getComponent(0);
                JMenuItem MenuItemAddBefore = (JMenuItem)m.getComponent(1);
                JMenuItem MenuItemDel = (JMenuItem)m.getComponent(2);
                JMenuItem MenuItemUpdateName = (JMenuItem)m.getComponent(3);
                JMenuItem MenuItemMoveAfter = (JMenuItem)m.getComponent(4);
                JMenuItem MenuItemMoveBefore = (JMenuItem)m.getComponent(5);
                if (FloorToolBar.this.enabled) {
                    if (FloorToolBar.this.floorTabList.size() == 1) {
                        MenuItemAddAfter.setEnabled(true);
                        MenuItemAddBefore.setEnabled(true);
                        MenuItemDel.setEnabled(false);
                        MenuItemUpdateName.setEnabled(true);
                        MenuItemMoveAfter.setEnabled(false);
                        MenuItemMoveBefore.setEnabled(false);
                    } else if (FloorToolBar.this.floorTabList.size() - 1 == FloorToolBar.this.currentFloorTabIndex) {
                        MenuItemAddAfter.setEnabled(true);
                        MenuItemAddBefore.setEnabled(true);
                        MenuItemDel.setEnabled(true);
                        MenuItemUpdateName.setEnabled(true);
                        MenuItemMoveAfter.setEnabled(false);
                        MenuItemMoveBefore.setEnabled(true);
                    } else if (FloorToolBar.this.currentFloorTabIndex == 0) {
                        MenuItemAddAfter.setEnabled(true);
                        MenuItemAddBefore.setEnabled(true);
                        MenuItemDel.setEnabled(true);
                        MenuItemUpdateName.setEnabled(true);
                        MenuItemMoveAfter.setEnabled(true);
                        MenuItemMoveBefore.setEnabled(false);
                    } else {
                        MenuItemAddAfter.setEnabled(true);
                        MenuItemAddBefore.setEnabled(true);
                        MenuItemDel.setEnabled(true);
                        MenuItemUpdateName.setEnabled(true);
                        MenuItemMoveAfter.setEnabled(true);
                        MenuItemMoveBefore.setEnabled(true);
                    }
                } else {
                    MenuItemAddAfter.setEnabled(false);
                    MenuItemAddBefore.setEnabled(false);
                    MenuItemDel.setEnabled(false);
                    MenuItemUpdateName.setEnabled(false);
                    MenuItemMoveAfter.setEnabled(false);
                    MenuItemMoveBefore.setEnabled(false);
                }
            }

            @Override
            public void popupMenuWillBecomeInvisible(PopupMenuEvent e) {
            }

            @Override
            public void popupMenuCanceled(PopupMenuEvent e) {
            }
        });
        newFloorTab.getBtnFloorTab().addMouseListener(new MouseListener(){

            @Override
            public void mouseReleased(MouseEvent e) {
            }

            @Override
            public void mousePressed(MouseEvent e) {
                if (FloorToolBar.this.enabled) {
                    FloorTab tab2;
                    for (FloorTab tab2 : FloorToolBar.this.floorTabList) {
                        if (!tab2.getTxtFloorName().isVisible()) continue;
                        return;
                    }
                    tab2 = (FloorTab)e.getComponent().getParent();
                    if (!FloorToolBar.this.GetCurrentFloorTab().equals(tab2)) {
                        FloorToolBar.this.SetCurrentFloor(tab2);
                    }
                    if (e.getButton() == 3) {
                        JComponent c = (JComponent)e.getSource();
                        popupmenu.show(c, e.getX(), e.getY());
                        e.consume();
                    }
                }
            }

            @Override
            public void mouseExited(MouseEvent e) {
            }

            @Override
            public void mouseEntered(MouseEvent e) {
            }

            @Override
            public void mouseClicked(MouseEvent e) {
            }
        });
        newFloorTab.getTxtFloorName().addFocusListener(new FocusListener(){

            @Override
            public void focusLost(FocusEvent e) {
                String text = newFloorTab.getTxtFloorName().getText();
                text = FloorToolBar.this.IllegalCharactersRemove(text);
                int idx = 0;
                while (idx < FloorToolBar.this.floorTabList.size()) {
                    if (FloorToolBar.this.currentFloorTabIndex != idx && text.toUpperCase().equals(((FloorTab)FloorToolBar.this.floorTabList.get(idx)).getFloorName().toUpperCase())) {
                        JOptionPane.showMessageDialog(((FloorToolBar)FloorToolBar.this).mapMaker.mapFrame, "フロアー名が重複しています。", "エラー", 0);
                        newFloorTab.getTxtFloorName().requestFocus();
                        return;
                    }
                    ++idx;
                }
                newFloorTab.getTxtFloorName().setText(text);
                FloorToolBar.this.SetNameUpdateMode(newFloorTab, false);
            }

            @Override
            public void focusGained(FocusEvent e) {
                JTextField txtFloorName = (JTextField)e.getSource();
                txtFloorName.setSelectionStart(0);
                txtFloorName.setSelectionEnd(txtFloorName.getText().length());
            }
        });
        newFloorTab.getTxtFloorName().addKeyListener(new KeyListener(){

            @Override
            public void keyTyped(KeyEvent e) {
            }

            @Override
            public void keyReleased(KeyEvent e) {
            }

            @Override
            public void keyPressed(KeyEvent e) {
                if (e.getKeyCode() == 10) {
                    newFloorTab.transferFocusBackward();
                }
            }
        });
        return newFloorTab;
    }

    private String IllegalCharactersRemove(String TargetStr) {
        TargetStr = TargetStr.replaceAll(Pattern.quote("\\"), "");
        TargetStr = TargetStr.replaceAll(Pattern.quote("/"), "");
        TargetStr = TargetStr.replaceAll(Pattern.quote(":"), "");
        TargetStr = TargetStr.replaceAll(Pattern.quote("*"), "");
        TargetStr = TargetStr.replaceAll(Pattern.quote("?"), "");
        TargetStr = TargetStr.replaceAll(Pattern.quote("\""), "");
        TargetStr = TargetStr.replaceAll(Pattern.quote("<"), "");
        TargetStr = TargetStr.replaceAll(Pattern.quote(">"), "");
        TargetStr = TargetStr.replaceAll(Pattern.quote("|"), "");
        return TargetStr;
    }

    private void SetSelect(FloorTab floorTab) {
        floorTab.getBtnFloorTab().setBackground(Color.GRAY);
    }

    private void SetUnSelect(FloorTab floorTab) {
        floorTab.getBtnFloorTab().setBackground(Color.WHITE);
    }

    private void SetNameUpdateMode(FloorTab floorTab, boolean mode) {
        if (mode) {
            floorTab.getTxtFloorName().setVisible(true);
            floorTab.getTxtFloorName().setMaximumSize(new Dimension(floorTab.getBtnFloorTab().getMaximumSize().width, floorTab.getTxtFloorName().getMaximumSize().height));
            floorTab.getBtnFloorTab().setVisible(false);
            floorTab.getTxtFloorName().requestFocus();
        } else {
            floorTab.getTxtFloorName().setVisible(false);
            floorTab.getBtnFloorTab().setVisible(true);
            floorTab.getBtnFloorTab().requestFocus();
            String name = floorTab.getTxtFloorName().getText();
            if (name.isEmpty()) {
                floorTab.getTxtFloorName().setText(floorTab.getFloorName());
                return;
            }
            this.mapMaker.worldMapMultiFloor.getWorldMapExtension(this.currentFloorTabIndex).setName(name);
            floorTab.setFloorName(name);
        }
    }
}

